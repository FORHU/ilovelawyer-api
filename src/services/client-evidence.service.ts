import ClientCaseSvc, { type ClientWorkspace } from "./client-case.service";
import MissingEvidenceRepo from "../repositories/missing-evidence.repository";
import IntakeChatRepo from "../repositories/intake-chat.repository";
import CaseAreaSvc from "./case-area.service";
import { assertClientAiOpen } from "../constants/client-sites.constants";
import { caseDetailsBlock } from "../utils/client-intake-extract";
import { conversationLines, languageOf } from "../utils/client-questions-plan";
import { buildEvidencePrompt, buildNotePrompt, evidenceStateOf as stateOf, parseEvidenceReply, readNoteReply, type EvidenceState } from "../utils/client-evidence-plan";
import DocumentNoteRepo from "../repositories/document-note.repository";
import ClientIntakeSvc from "./client-intake.service";
import { buildFactExcerptPack } from "../utils/case-document-excerpts";

/** How much of a document, and of the story, the note's prompt is given. */
const NOTE_CONTENT_MAX_CHARS = 3000;
const NOTE_STORY_MAX_CHARS = 1500;
import { callChatWonderRest, getChatWonderSessionId } from "../utils/chatWonder";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";

export { evidenceStateOf as stateOf, type EvidenceState, type EvidenceSuggestionView } from "../utils/client-evidence-plan";

/** A day as the client sees it, UK time (as client-intake.service.ts's ukDay). */
function ukDay(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/**
 * The evidence step after the questions (the new-client flow, step 4): the proof a case would
 * benefit from, suggested from the client's story and answers with one Chat Wonder call. Saved as
 * the case's CaseMissingEvidence gaps under their own marker (CLIENT_INTAKE_EVIDENCE_NOTE), so the
 * lawyer analysis never replaces them, the lawyer sees what the client was asked for, and an upload
 * that carries one's id marks it filled (ClientCaseSvc.addDocument).
 *
 * No chat credit is spent: the call counts toward the case's AI usage like the intake reading.
 */
export default class ClientEvidenceSvc {
  /** The case's suggestions, without writing any: null when there are none yet. Never calls the AI. */
  static async read(workspace: ClientWorkspace, caseId: string): Promise<EvidenceState | null> {
    await ClientCaseSvc.load(workspace, caseId);
    const rows = await MissingEvidenceRepo.listClientIntake(caseId);
    return rows.length ? stateOf(rows) : null;
  }

  /** The case's suggestions, written the first time (one AI call), the same ones after. A call that
   * fails saves nothing, so the next start tries again; a reply with too few usable suggestions gets
   * the app's general ones. */
  static async start(workspace: ClientWorkspace, userId: string, caseId: string): Promise<EvidenceState> {
    assertClientAiOpen(workspace.tenantCode);
    const caseRow = await ClientCaseSvc.load(workspace, caseId);
    const existing = await MissingEvidenceRepo.listClientIntake(caseId);
    if (existing.length) return stateOf(existing);

    const messages = await IntakeChatRepo.listByCase(caseId);
    const language = languageOf(messages.find((m) => m.role === "user")?.content ?? "");
    const prompt = buildEvidencePrompt({
      tenantCode: workspace.tenantCode,
      caseDetails: caseDetailsBlock(
        {
          title: caseRow.caseName,
          caseAreas: (await CaseAreaSvc.refsOf(CaseAreaSvc.clientPicks(caseRow), workspace.tenantCode)).map((a) => a.name),
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
      documents: caseRow.documents.map((d) => d.name),
      today: ukDay(new Date()),
      language,
    });

    let reply: string;
    try {
      const answer = await callChatWonderRest(prompt, await getChatWonderSessionId(), undefined, workspace.tenantCode, {
        usage: { feature: "clientEvidenceSuggest", userId, caseId },
      });
      reply = String(answer.response ?? answer.intermediate_response ?? "");
    } catch (err) {
      logger.warn("Client evidence: suggesting proof failed", { err, caseId });
      throw new HttpError("We couldn't suggest what to add just now.", 502, "EVIDENCE_FAILED");
    }

    const { suggestions, fromAi } = parseEvidenceReply(reply, language);
    if (!fromAi) logger.info("Client evidence: using general suggestions", { caseId });
    const rows = await MissingEvidenceRepo.createClientIntakeOnce(
      caseId,
      suggestions.map((s) => ({ label: s.title, detail: s.why || null, suggestedSource: s.source })),
    );
    return stateOf(rows);
  }

  /**
   * Drafts the note on each of the case's newly read documents that has none, in the story's
   * language, from what was read and the suggestion it fills. Only on a case in the evidence step
   * (it has suggestions), and at most a batch at a time. Run after the case's documents are read
   * (case-post-extraction.ts), before the intake reading, so the reading has the notes. A draft that
   * comes back empty or unusable is saved as tried; a failed call is tried again next time. Never
   * throws. Returns how many notes were drafted.
   */
  static async draftNotes(caseId: string, userId: string): Promise<number> {
    try {
      const suggestions = await MissingEvidenceRepo.listClientIntake(caseId);
      if (!suggestions.length) return 0;
      const docs = await DocumentNoteRepo.listNeedingDraft(caseId);
      if (!docs.length) return 0;
      const story = (await IntakeChatRepo.listByCase(caseId)).find((m) => m.role === "user")?.content ?? "";
      const language = languageOf(story);

      let drafted = 0;
      for (const doc of docs) {
        let reply: string;
        try {
          const pack = await buildFactExcerptPack([{ id: doc.id, name: doc.name }]);
          const prompt = buildNotePrompt({
            name: doc.name,
            category: doc.category,
            content: pack.text.slice(0, NOTE_CONTENT_MAX_CHARS),
            fills: suggestions.find((s) => s.filledByDocumentId === doc.id)?.label ?? null,
            story: story.slice(0, NOTE_STORY_MAX_CHARS),
            language,
          });
          // A JSON-writing task, routed as the intake reading's is; the language is named in the prompt.
          const answer = await callChatWonderRest(prompt, await getChatWonderSessionId(), undefined, "UK", {
            usage: { feature: "clientDocumentNote", userId, caseId },
          });
          reply = String(answer.response ?? answer.intermediate_response ?? "");
        } catch (err) {
          logger.warn("Client evidence: drafting a note failed, will try again", { err, caseId, documentId: doc.id });
          continue;
        }
        const read = readNoteReply(reply, language);
        // An empty reply is the AI having nothing to say; anything else dropped is worth knowing about.
        if ("why" in read && read.why !== "empty") {
          logger.info("Client evidence: a drafted note was discarded", { caseId, documentId: doc.id, why: read.why, replyChars: reply.length });
        }
        if ((await DocumentNoteRepo.saveDraft(doc.id, read.note)) && read.note) drafted += 1;
      }
      return drafted;
    } catch (err) {
      logger.error("Client evidence: drafting notes failed", { err, caseId });
      return 0;
    }
  }

  /** The client's own note on one of their documents, replacing any draft (empty clears it). */
  static async setNote(workspace: ClientWorkspace, caseId: string, documentId: string, note: string): Promise<{ documentId: string; note: string | null; noteBy: "CLIENT" }> {
    await ClientCaseSvc.load(workspace, caseId);
    const text = note.trim();
    if (!(await DocumentNoteRepo.saveClientNote(documentId, caseId, text))) throw new HttpError("Document not found", 404);
    return { documentId, note: text || null, noteBy: "CLIENT" };
  }

  /** "Done": the client has added what they have. The intake reading runs once over the new proof
   * and notes (its fingerprint skips it when nothing changed). Returns the suggestions. */
  static async done(workspace: ClientWorkspace, userId: string, caseId: string): Promise<EvidenceState | null> {
    await ClientCaseSvc.load(workspace, caseId);
    await ClientIntakeSvc.scheduleAuto(caseId, userId, "evidence");
    const rows = await MissingEvidenceRepo.listClientIntake(caseId);
    return rows.length ? stateOf(rows) : null;
  }

  /** "I don't have this" (`dismissed` true), or taking it back. The gap stays open for the lawyer. */
  static async setDismissed(workspace: ClientWorkspace, caseId: string, suggestionId: string, dismissed: boolean): Promise<EvidenceState> {
    await ClientCaseSvc.load(workspace, caseId);
    if (!(await MissingEvidenceRepo.setClientDismissed(suggestionId, caseId, dismissed ? new Date() : null))) {
      throw new HttpError("Suggestion not found", 404);
    }
    return stateOf(await MissingEvidenceRepo.listClientIntake(caseId));
  }
}
