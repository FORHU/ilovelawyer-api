import ClientCaseSvc, { type ClientCaseDto, type ClientWorkspace } from "./client-case.service";
import ClientIntakeSvc from "./client-intake.service";
import IntakeChatSvc from "./intake-chat.service";
import AiGenerationLockSvc from "./ai-generation-lock.service";
import IntakeChatRepo from "../repositories/intake-chat.repository";
import { assertClientAiOpen } from "../constants/client-sites.constants";
import { OTHER_CASE_AREA } from "../constants/case-area.constants";
import { isJobStale } from "../utils/ai-generation-lock.utils";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";
import type { CaseIntake } from "../types/client-intake";
import { storyTitle } from "../utils/client-intake-extract";
import { languageOf } from "../utils/client-questions-plan";
import { buildStoryFactsPrompt, parseStoryFactsReply, type StoryFact } from "../utils/client-story-facts";
import { callChatWonderRest, getChatWonderSessionId } from "../utils/chatWonder";

export { storyTitle };

export interface StoryStarted {
  case: ClientCaseDto;
  messageId: string;
  /** RUNNING when the extraction was queued; the app polls GET .../intake until READY or FAILED. */
  intake: CaseIntake;
}

/**
 * The story-first way into a case (the new-client flow's "Your story" screen): the client tells
 * what happened in one go, by voice or typing, before any question is asked. The story is kept as
 * the case's first intake message with no reply asked for, so Chat Wonder says nothing yet; the
 * intake extraction reads it straight away and the app shows "Here's your story so far" from the
 * result. When the client later starts the chat, its first turn opens a fresh Chat Wonder session,
 * which replays the story as earlier conversation (IntakeChatSvc.earlierConversationBlock), so the
 * AI carries on from it instead of asking again.
 *
 * Neither call spends a chat credit: no chat answer is generated. The extraction counts against
 * the case's AI budget like every intake run, never against the daily Update cap.
 */
export default class ClientStorySvc {
  /** Makes the case from the story and starts reading it. */
  static async start(workspace: ClientWorkspace, userId: string, text: string): Promise<StoryStarted> {
    // The intake persona and extraction are per site: never read a story on a site without them.
    assertClientAiOpen(workspace.tenantCode);
    // Placeholder details, as the chat's first message makes (the client app's describeCasePayload):
    // the area isn't known yet and nobody has said where the case is.
    const created = await ClientCaseSvc.create(workspace, userId, {
      title: storyTitle(text),
      areas: [OTHER_CASE_AREA],
      ukJurisdiction: null,
      outsideUk: false,
    });

    let messageId: string;
    try {
      messageId = (await IntakeChatRepo.createMessage(created.id, "user", text, userId)).id;
    } catch (err) {
      // A case with no story is no use to the client, who will tell it again: don't leave it behind.
      await ClientCaseSvc.remove(workspace, userId, created.id).catch((removeErr) =>
        logger.error("Client story: couldn't remove a case whose story wasn't saved", { err: removeErr, caseId: created.id }),
      );
      throw err;
    }

    await ClientIntakeSvc.scheduleAuto(created.id, userId, "story");
    return { case: created, messageId, intake: await ClientIntakeSvc.get(workspace, created.id) };
  }

  /** "Something's not right": adds the client's fix after the story and reads the case again. */
  static async correct(workspace: ClientWorkspace, userId: string, caseId: string, text: string): Promise<{ messageId: string; intake: CaseIntake }> {
    assertClientAiOpen(workspace.tenantCode);
    await ClientCaseSvc.load(workspace, caseId);

    // A run already reading the case wouldn't see the fix, and its result would show as stale with
    // nothing more queued. The app only offers the fix once the first reading is done.
    const job = await AiGenerationLockSvc.getStatus(caseId, "clientIntake");
    if (job?.status === "IN_PROGRESS" && !isJobStale(job)) {
      throw new HttpError("We're still reading your story. Try again in a moment.", 409, "INTAKE_RUNNING");
    }
    if (await IntakeChatRepo.hasPendingTurn(caseId)) {
      throw new HttpError("An answer is still being written. Wait for it, then add your fix.", 409, "TURN_IN_PROGRESS");
    }

    const message = await IntakeChatRepo.createMessage(caseId, "user", text, userId);
    // A Chat Wonder session already open on this case never saw the fix: the next turn starts a
    // fresh one, which replays the chat with the fix in it.
    await IntakeChatSvc.forgetSession(caseId);
    await ClientIntakeSvc.scheduleAuto(caseId, userId, "story");
    return { messageId: message.id, intake: await ClientIntakeSvc.get(workspace, caseId) };
  }

  /**
   * The story's key facts as short labelled chips ("Date Mar 3, 2026"), for the screen to show while
   * the full reading runs: one small Chat Wonder call, in the story's language. Shown only, never
   * stored. Never fails: a call that doesn't work gives no facts, and the screen shows no chips.
   */
  static async facts(workspace: ClientWorkspace, userId: string, caseId: string): Promise<{ facts: StoryFact[] }> {
    assertClientAiOpen(workspace.tenantCode);
    await ClientCaseSvc.load(workspace, caseId);
    const story = (await IntakeChatRepo.listByCase(caseId)).find((m) => m.role === "user")?.content ?? "";
    if (!story.trim()) return { facts: [] };
    const language = languageOf(story);
    const prompt = buildStoryFactsPrompt({ story, language, today: new Date().toISOString().slice(0, 10) });
    try {
      const answer = await callChatWonderRest(prompt, await getChatWonderSessionId(), undefined, workspace.tenantCode, {
        usage: { feature: "clientStoryFacts", userId, caseId },
      });
      return { facts: parseStoryFactsReply(String(answer.response ?? answer.intermediate_response ?? ""), language) };
    } catch (err) {
      logger.warn("Client story: picking out the facts failed", { err, caseId });
      return { facts: [] };
    }
  }
}
