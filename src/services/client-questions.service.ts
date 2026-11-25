import ClientCaseSvc, { type ClientWorkspace } from "./client-case.service";
import ClientIntakeSvc from "./client-intake.service";
import CaseQuestionsRepo, { type CaseQuestionsRow } from "../repositories/case-questions.repository";
import IntakeChatRepo from "../repositories/intake-chat.repository";
import { assertClientAiOpen } from "../constants/client-sites.constants";
import { caseDetailsBlock } from "../utils/client-intake-extract";
import {
  QUESTION_PLAN_VERSION,
  buildAnswerCheckPrompt,
  buildQuestionsPrompt,
  capQuestions,
  conversationLines,
  followUpId,
  openDetails,
  parseAnswerCheck,
  parseQuestionsReply,
  languageOf,
  plannedFollowUp,
  townQuestion,
  ukPlaceQuestion,
  type PlanLanguage,
  type PlannedQuestion,
  type QuestionDetail,
  type QuestionPlan,
  type QuestionPrompt,
} from "../utils/client-questions-plan";
import IntakeChatSvc from "./intake-chat.service";
import ClientCaseRepo from "../repositories/client-case.repository";
import { CLIENT_CASE_WHERE_MAX_LENGTH } from "../constants/client-case.constants";
import { callChatWonderRest, getChatWonderSessionId } from "../utils/chatWonder";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";

/** A list still marked as being written after this long was abandoned (the server stopped mid-way):
 * the next start writes it again. */
const PLANNING_STALE_MS = 2 * 60 * 1000;

/** The question the client is on, as the screen shows it. */
export interface QuestionView {
  /** The detail's id, or its follow-up's (followUpId). Sent back with the answer. */
  id: string;
  detail: QuestionDetail;
  question: string;
  why: string;
  chips: string[];
  /** A follow-up within the same detail: it doesn't move the progress bar. */
  followUp: boolean;
}

/** Where a case's questions are: what the Questions screen draws. */
export interface QuestionsState {
  status: "OPEN" | "DONE";
  /** Fixed when the list is written: the "M" in "N of M details". 0 when nothing needed asking. */
  total: number;
  answered: number;
  skipped: number;
  /** The next question; null once done. */
  current: QuestionView | null;
  /** The questions already dealt with, oldest first, to redraw the thread on coming back. */
  history: { id: string; question: string; why: string; answer: string | null; skipped: boolean }[];
}

/** The question the client is on: the open detail's own, or its follow-up once that's been asked. */
function currentOf(question: PlannedQuestion): QuestionView {
  const follow = question.followUp?.status === "OPEN" ? question.followUp : null;
  return follow
    ? { id: followUpId(question.detail), detail: question.detail, question: follow.question, why: follow.why, chips: follow.chips, followUp: true }
    : { id: question.id, detail: question.detail, question: question.question, why: question.why, chips: question.chips, followUp: false };
}

export function stateOf(row: Pick<CaseQuestionsRow, "status" | "total" | "plan">): QuestionsState {
  const questions = row.plan?.questions ?? [];
  const next = questions.find((q) => q.status === "OPEN");
  const history: QuestionsState["history"] = [];
  for (const q of questions) {
    // Asked and dealt with: answered (maybe waiting on its follow-up), or skipped.
    if (q.status === "OPEN" && q.answer === null) continue;
    history.push({ id: q.id, question: q.question, why: q.why, answer: q.answer, skipped: q.answer === null });
    const follow = q.followUp;
    if (follow && follow.status !== "OPEN") {
      history.push({ id: followUpId(q.detail), question: follow.question, why: follow.why, answer: follow.answer, skipped: follow.answer === null });
    }
  }
  return {
    status: row.status === "DONE" || !next ? "DONE" : "OPEN",
    total: row.total,
    answered: questions.filter((q) => q.status === "ANSWERED").length,
    skipped: questions.filter((q) => q.status === "SKIPPED").length,
    current: next ? currentOf(next) : null,
    history,
  };
}

/** How the client gave an answer. */
export type AnswerVia = "tap" | "typed" | "voice";

/** What a skipped question records as the client's words, unless the app sends them in the client's
 * own language. */
export const DEFAULT_SKIP_TEXT = "I'm not sure.";

/** A day as the client sees it, UK time (as client-intake.service.ts's ukDay). */
function ukDay(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/**
 * The Questions step after a client's story (the new-client flow, step 3): the details the case still
 * needs, asked one at a time. This is the list: written once per case from what the intake reading
 * still lists as missing and what the lawyer readiness check hasn't seen, with one Chat Wonder call
 * that words each question for this client, in their language. Answering is ClientQuestionsSvc's
 * next part (slice 2).
 *
 * No chat credit is spent: the call counts toward the case's AI usage like the intake reading.
 */
export default class ClientQuestionsSvc {
  /** Starts the questions, or picks them up where the client left off. */
  static async start(workspace: ClientWorkspace, userId: string, caseId: string): Promise<QuestionsState> {
    assertClientAiOpen(workspace.tenantCode);
    const caseRow = await ClientCaseSvc.load(workspace, caseId);

    const existing = await CaseQuestionsRepo.find(caseId);
    if (existing) {
      if (existing.status !== "PLANNING") return stateOf(existing);
      if (Date.now() - existing.updatedAt.getTime() < PLANNING_STALE_MS) {
        throw new HttpError("Your questions are being prepared. Try again in a moment.", 409, "QUESTIONS_PREPARING");
      }
      await CaseQuestionsRepo.release(caseId);
    }

    // The questions follow the story's reading: until it's done, the missing details aren't known.
    const intake = await ClientIntakeSvc.get(workspace, caseId);
    if (intake.status === "RUNNING") {
      throw new HttpError("We're still reading your story. Try again in a moment.", 409, "INTAKE_RUNNING");
    }

    const details = openDetails({
      tenantCode: workspace.tenantCode,
      place: { ukJurisdiction: caseRow.ukJurisdiction, outsideUk: caseRow.outsideUk, where: caseRow.jurisdiction },
      missing: intake.formFields.missing,
      unmetReadiness: intake.completeness ? intake.completeness.criteria.filter((c) => !c.met).map((c) => c.key) : null,
    });

    if (!(await CaseQuestionsRepo.claim(caseId))) {
      // Another start got there first: show its list, or ask to wait while it's written.
      const raced = await CaseQuestionsRepo.find(caseId);
      if (raced && raced.status !== "PLANNING") return stateOf(raced);
      throw new HttpError("Your questions are being prepared. Try again in a moment.", 409, "QUESTIONS_PREPARING");
    }

    try {
      const plan = await ClientQuestionsSvc.write(workspace, userId, caseRow, details, intake.formFields.typeOfAction);
      const total = plan.questions.length;
      await CaseQuestionsRepo.save(caseId, { status: total ? "OPEN" : "DONE", total, plan });
      logger.info("Client questions: list written", { caseId, details: plan.questions.map((q) => q.detail), dropped: plan.dropped.map((d) => d.detail) });
      return stateOf({ status: total ? "OPEN" : "DONE", total, plan });
    } catch (err) {
      await CaseQuestionsRepo.release(caseId).catch((releaseErr) => logger.error("Client questions: couldn't release a failed list", { err: releaseErr, caseId }));
      throw err;
    }
  }

  /** Where a case's questions are, without starting them: null when there's no list yet (or it's
   * still being written). For the case page's "questions left" banner; never calls the AI. */
  static async read(workspace: ClientWorkspace, caseId: string): Promise<QuestionsState | null> {
    await ClientCaseSvc.load(workspace, caseId);
    const row = await CaseQuestionsRepo.find(caseId);
    return row && row.status !== "PLANNING" ? stateOf(row) : null;
  }

  /**
   * The client's answer to the question they're on (`questionId`, as the screen was given it). Kept
   * on the list, and in the case's chat as the question and the answer, with no AI reply asked
   * for. A place answer goes onto the case. It may lead to one follow-up within the same detail:
   * the one the list gave its chip (or any answer), or, for a typed or spoken answer that isn't a
   * chip, the one a small AI check asks for. A check that fails or is slow just moves on.
   */
  static async answer(workspace: ClientWorkspace, userId: string, caseId: string, input: { questionId: string; text: string; via: AnswerVia }): Promise<QuestionsState> {
    const { row, question, onFollowUp } = await ClientQuestionsSvc.onQuestion(workspace, caseId, input.questionId);
    const text = input.text.trim();
    const asked = onFollowUp ? question.followUp! : question;
    const caseChanges: { ukJurisdiction?: string | null; outsideUk?: boolean; where?: string } = {};

    if (onFollowUp) {
      question.followUp = { ...question.followUp!, status: "ANSWERED", answer: text };
      question.status = "ANSWERED";
      // The UK's town, after its part of the UK.
      if (question.detail === "place") caseChanges.where = text.slice(0, CLIENT_CASE_WHERE_MAX_LENGTH);
    } else {
      question.answer = text;
      const { chip, followUp: planned } = plannedFollowUp(question, text, workspace.tenantCode);
      if (question.detail === "place") {
        if (workspace.tenantCode !== "UK") caseChanges.where = text.slice(0, CLIENT_CASE_WHERE_MAX_LENGTH);
        else if (chip === "Outside the UK") Object.assign(caseChanges, { ukJurisdiction: null, outsideUk: true });
        else if (chip) caseChanges.ukJurisdiction = chip;
      }
      let followUp: QuestionPrompt | null = planned;
      // A typed or spoken answer that's none of the chips: ask the AI whether it's the whole detail.
      if (!followUp && !chip && input.via !== "tap" && question.detail !== "place") {
        followUp = await ClientQuestionsSvc.checkAnswer(workspace, userId, caseId, question, text, row.plan!.language ?? "en");
      }
      if (followUp) question.followUp = { ...followUp, status: "OPEN", answer: null };
      else question.status = "ANSWERED";
    }

    return ClientQuestionsSvc.record(workspace, userId, caseId, row, { asked: asked.question, said: text, caseChanges });
  }

  /** "I don't know, skip": the question is left for the lawyer to ask. A skipped follow-up leaves its
   * detail answered as far as it went. `text` is what the client is shown saying, in their language. */
  static async skip(workspace: ClientWorkspace, userId: string, caseId: string, input: { questionId: string; text?: string }): Promise<QuestionsState> {
    const { row, question, onFollowUp } = await ClientQuestionsSvc.onQuestion(workspace, caseId, input.questionId);
    const asked = onFollowUp ? question.followUp! : question;
    if (onFollowUp) {
      question.followUp = { ...question.followUp!, status: "SKIPPED", answer: null };
      question.status = "ANSWERED";
    } else {
      question.status = "SKIPPED";
      question.answer = null;
    }
    return ClientQuestionsSvc.record(workspace, userId, caseId, row, { asked: asked.question, said: input.text?.trim() || DEFAULT_SKIP_TEXT, caseChanges: {} });
  }

  /** The case's list and the question the client is on, checked against the one they answered. */
  private static async onQuestion(workspace: ClientWorkspace, caseId: string, questionId: string) {
    assertClientAiOpen(workspace.tenantCode);
    await ClientCaseSvc.load(workspace, caseId);
    const row = await CaseQuestionsRepo.find(caseId);
    if (!row || row.status === "PLANNING" || !row.plan) {
      throw new HttpError("Start the questions first.", 409, "QUESTIONS_NOT_STARTED");
    }
    const question = row.plan.questions.find((q) => q.status === "OPEN");
    if (row.status === "DONE" || !question) throw new HttpError("These questions are already done.", 409, "QUESTIONS_DONE");
    const current = currentOf(question);
    // An answer from a screen that's behind (another tab, a double tap) never lands on the wrong question.
    if (current.id !== questionId) throw new HttpError("That question has already been answered.", 409, "QUESTION_NOT_CURRENT");
    if (await IntakeChatRepo.hasPendingTurn(caseId)) {
      throw new HttpError("An answer is still being written in your chat. Wait for it, then carry on.", 409, "TURN_IN_PROGRESS");
    }
    return { row, question, onFollowUp: current.followUp };
  }

  /** Saves the changed list (refused if another answer saved first), then keeps the question and the
   * client's words in the case's chat, puts a place answer on the case, and, after the last
   * question, reads the case again. */
  private static async record(
    workspace: ClientWorkspace,
    userId: string,
    caseId: string,
    row: CaseQuestionsRow,
    turn: { asked: string; said: string; caseChanges: { ukJurisdiction?: string | null; outsideUk?: boolean; where?: string } },
  ): Promise<QuestionsState> {
    const plan = row.plan!;
    const done = plan.questions.every((q) => q.status !== "OPEN");
    const status = done ? "DONE" : "OPEN";
    if (!(await CaseQuestionsRepo.saveIfUnchanged(caseId, row.updatedAt, { status, plan }))) {
      throw new HttpError("That question has already been answered.", 409, "QUESTION_NOT_CURRENT");
    }

    // The chat shows them as asked and answered, in that order; neither asks the AI for a reply.
    await IntakeChatRepo.createExchange(caseId, userId, turn.asked, turn.said);
    // An AI session already open on this case never saw them: its next turn replays the chat.
    await IntakeChatSvc.forgetSession(caseId);

    if (Object.keys(turn.caseChanges).length) {
      // A refusal (a lawyer already holds the request) leaves the answer in the chat for the lawyer.
      await ClientCaseSvc.update(workspace, userId, caseId, turn.caseChanges, { refreshIntake: false }).catch((err) =>
        logger.warn("Client questions: couldn't put a place answer on the case", { err, caseId }),
      );
    }

    if (done) await ClientQuestionsSvc.finish(caseId, userId);
    return stateOf({ status, total: row.total, plan });
  }

  /** After the last question: the intake reading runs once over every answer, and the lawyer
   * readiness check is asked again next time (its stored answer predates the last reply). */
  private static async finish(caseId: string, userId: string): Promise<void> {
    await ClientCaseRepo.clearReadiness(caseId).catch((err) => logger.warn("Client questions: couldn't clear the readiness check", { err, caseId }));
    await ClientIntakeSvc.scheduleAuto(caseId, userId, "questions");
  }

  /** The follow-up a typed or spoken answer needs, or null: complete, or the check failed. */
  private static async checkAnswer(
    workspace: ClientWorkspace,
    userId: string,
    caseId: string,
    question: PlannedQuestion,
    answer: string,
    language: PlanLanguage,
  ): Promise<QuestionPrompt | null> {
    try {
      const reply = await callChatWonderRest(
        buildAnswerCheckPrompt({ detail: question.detail, question: question.question, answer, tenantCode: workspace.tenantCode, language }),
        await getChatWonderSessionId(),
        undefined,
        workspace.tenantCode,
        { usage: { feature: "clientQuestionsCheck", userId, caseId } },
      );
      return parseAnswerCheck(String(reply.response ?? reply.intermediate_response ?? ""), language);
    } catch (err) {
      logger.warn("Client questions: answer check failed, moving on", { err, caseId, detail: question.detail });
      return null;
    }
  }

  /** The list for `details`: the AI's questions, with the UK's own place question first, capped. */
  private static async write(
    workspace: ClientWorkspace,
    userId: string,
    caseRow: Awaited<ReturnType<typeof ClientCaseSvc.load>>,
    details: QuestionDetail[],
    caseAreaNames: string[],
  ): Promise<QuestionPlan> {
    const ukPlace = workspace.tenantCode === "UK" && details.includes("place");
    const forAi = details.filter((d) => !(ukPlace && d === "place"));

    let written: Omit<QuestionPlan, "version"> = { questions: [], dropped: [] };
    // The questions' language is the story's, decided here rather than left to the AI.
    let language: PlanLanguage = "en";
    if (forAi.length) {
      const messages = await IntakeChatRepo.listByCase(caseRow.id);
      language = languageOf(messages.find((m) => m.role === "user")?.content ?? "");
      const prompt = buildQuestionsPrompt({
        tenantCode: workspace.tenantCode,
        details: forAi,
        caseDetails: caseDetailsBlock(
          {
            title: caseRow.caseName,
            caseAreas: caseAreaNames,
            ukJurisdiction: caseRow.ukJurisdiction,
            outsideUk: caseRow.outsideUk,
            where: caseRow.jurisdiction,
            side: caseRow.clientSide,
            notes: caseRow.notes,
          },
          caseRow.parties.map((p) => ({ name: p.name, designation: p.designation })),
          workspace.tenantCode === "UK",
        ),
        conversation: conversationLines(messages),
        today: ukDay(new Date()),
        language,
      });
      let parsed: Omit<QuestionPlan, "version"> | null = null;
      try {
        const reply = await callChatWonderRest(prompt, await getChatWonderSessionId(), undefined, workspace.tenantCode, {
          usage: { feature: "clientQuestions", userId, caseId: caseRow.id },
        });
        parsed = parseQuestionsReply(String(reply.response ?? reply.intermediate_response ?? ""), { details: forAi, tenantCode: workspace.tenantCode, language });
      } catch (err) {
        logger.warn("Client questions: writing the list failed", { err, caseId: caseRow.id });
      }
      if (!parsed) throw new HttpError("We couldn't prepare your questions just now.", 502, "QUESTIONS_FAILED");
      written = parsed;
    }

    // Outside the UK the AI decides whether the town still needs asking and suggests the places to
    // tap, but the question itself is the app's: always the same plain words, in the story's language.
    const aiQuestions = written.questions.map((q) => (q.detail === "place" ? { ...q, ...townQuestion(language, q.chips), followUps: {} } : q));
    const questions = capQuestions([...(ukPlace ? [ukPlaceQuestion()] : []), ...aiQuestions]);
    return { version: QUESTION_PLAN_VERSION, questions, dropped: written.dropped, language };
  }
}
