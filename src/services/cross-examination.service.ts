import ManualEditLog from "./manual-edit-log.service";
import CaseAccess from "../utils/case-access";
import CaseSnapshotSvc from "./case-snapshot.service";
import WitnessRepo from "../repositories/witness.repository";
import DocumentChunkRepo from "../repositories/document-chunk.repository";
import CrossExamRepo, { AiCrossExamRow, CrossExamEdit } from "../repositories/cross-examination.repository";
import OrganizationRepo from "../repositories/organization.repository";
import AiGenerationLockSvc from "./ai-generation-lock.service";
import { getCrossExaminationPromptBuilder } from "../legal/prompt-registry";
import { getChatWonderSessionId, streamChatWonderMessage } from "../utils/chatWonder";
import { newTraceRun } from "./trace-collector.service";
import { extractCrossExamination, pageOfQuote } from "../utils/cross-examination-parse";
import { checkCrossExamSupportWithJev } from "../utils/cross-examination-jev";
import { quoteAppearsIn } from "../utils/witness-scoring-parse";
import { documentHandles } from "../utils/case-document-handles";
import type { CrossExamPromptDocument } from "../constants/cross-examination.constants";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";

// The documents shown to the model, in priority order (the witness's own, then the other side of
// their contradictions, then the rest of the case), within a total budget.
const MAX_DOCS = 8;
const MAX_DOC_CHARS = 8000;
const MAX_TOTAL_DOC_CHARS = 40000;
const MAX_EXCERPT = 160;
// Jev calls in flight at once while checking a witness's questions.
const JEV_BATCH = 5;

function clip(text: string): string {
  return text.length > MAX_EXCERPT ? `${text.slice(0, MAX_EXCERPT)}…` : text;
}

/**
 * Cross-examination questions for a witness the other side calls, each resting on a verbatim
 * passage from the case's documents. A question whose passage isn't in its document is dropped
 * before it's stored; Jev then reads whether the passage supports the fact the question puts, and
 * a question it doesn't support is kept and shown as such. The lawyer accepts, rejects or rewords
 * each one (CrossExamRepo.update), and a regeneration keeps what they touched.
 *
 * Only for THEIRS witnesses: in England and Wales, rehearsing our own witness's evidence is
 * witness coaching, which is prohibited (R v Momodou [2005] EWCA Crim 177). Familiarising our own
 * witness with the process is allowed, but that is not what this builds.
 */
export default class CrossExaminationSvc {
  static async list(caseId: string, witnessId: string, userId: string) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    return CrossExamRepo.listByWitness(caseId, witnessId);
  }

  /** Fast, synchronous half — access check, a THEIRS witness, claiming the job row — so a 4xx
   * surfaces before the enqueue rather than inside the worker. */
  static async beginQueued(caseId: string, witnessId: string, userId: string): Promise<void> {
    await CaseAccess.assertCanEdit(caseId, userId);
    const witness = await WitnessRepo.find(witnessId, caseId);
    if (!witness) throw new HttpError("Witness not found", 404);
    if (witness.calledBy !== "THEIRS") {
      throw new HttpError("Cross-examination prep is only for witnesses the other side calls. Set who calls this witness first.", 400);
    }
    // A pane's own action never overlaps the case analysis (ADR 0018).
    await AiGenerationLockSvc.assertAnalysisIdle(caseId);
    await AiGenerationLockSvc.begin(caseId, "crossExamination");
  }

  /** Run by AiGenerationQueue's worker after beginQueued claimed the job row. */
  static async runQueued(caseId: string, witnessId: string, userId: string): Promise<void> {
    await AiGenerationLockSvc.finishWith(caseId, "crossExamination", () =>
      CrossExaminationSvc.generateInner(caseId, witnessId, userId),
    );
  }

  static async update(caseId: string, id: string, userId: string, edit: CrossExamEdit) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const before = await CrossExamRepo.find(id, caseId);
    if (!before) throw new HttpError("Question not found", 404);
    const row = await CrossExamRepo.update(id, caseId, {
      ...edit,
      ...(edit.question !== undefined ? { question: edit.question.trim() } : {}),
      ...(edit.topic !== undefined ? { topic: edit.topic.trim() } : {}),
      ...(edit.purpose !== undefined ? { purpose: edit.purpose?.trim() || null } : {}),
    });
    if (!row) throw new HttpError("Question not found", 404);
    await OrganizationRepo.writeAudit({
      caseId,
      actorId: userId,
      action: "witness.cross_exam.update",
      payload: { id, witnessId: row.witnessId, status: row.status },
    });
    const statusChanged = before.status !== row.status;
    await ManualEditLog.record(caseId, userId, {
      pane: "witnesses",
      kind: "crossExamQuestion",
      itemId: id,
      action: statusChanged && row.status === "ACCEPTED" ? "accepted" : statusChanged && row.status === "REJECTED" ? "dismissed" : "edited",
      label: row.question,
    });
    return row;
  }

  static async delete(caseId: string, id: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const before = await CrossExamRepo.find(id, caseId);
    if (!before || !(await CrossExamRepo.delete(id, caseId))) throw new HttpError("Question not found", 404);
    await ManualEditLog.record(caseId, userId, {
      pane: "witnesses",
      kind: "crossExamQuestion",
      itemId: id,
      action: "removed",
      label: before.question,
    });
  }

  private static async generateInner(caseId: string, witnessId: string, userId: string) {
    const tenantCode = await CaseAccess.resolveTenantCode(caseId);
    const ukJurisdiction = tenantCode === "UK" ? await CaseAccess.resolveUkJurisdiction(caseId) : null;
    const snapshot = await CaseSnapshotSvc.get(caseId, userId);
    const witness = await WitnessRepo.find(witnessId, caseId);
    if (!witness) throw new HttpError("Witness not found", 404);

    const ready = snapshot.documents.filter((d) => d.ragStatus === "READY");
    const readyIds = new Set(ready.map((d) => d.id));
    const own = [
      ...snapshot.evidence.matrix.filter((m) => m.sponsoringWitnessId === witnessId).map((m) => m.documentId),
      ...(witness.sourceDocumentId ? [witness.sourceDocumentId] : []),
    ].filter((id) => readyIds.has(id));
    const ownSet = new Set(own);
    const touching = snapshot.evidence.contradictions.filter(
      (c) => ownSet.has(c.leftDocumentId) || ownSet.has(c.rightDocumentId),
    );
    const counterparts = touching.flatMap((c) => [c.leftDocumentId, c.rightDocumentId]).filter((id) => readyIds.has(id));
    const ordered = [...new Set([...own, ...counterparts, ...ready.map((d) => d.id)])].slice(0, MAX_DOCS);
    if (ordered.length === 0) throw new HttpError("Add documents to this case before preparing a cross-examination.", 400);

    const docs = ordered.map((id) => ({ id, name: ready.find((d) => d.id === id)!.name }));
    const handles = documentHandles(docs);
    const handleById = new Map([...handles].map(([handle, doc]) => [doc.id, handle]));
    const perDocChars = Math.min(MAX_DOC_CHARS, Math.floor(MAX_TOTAL_DOC_CHARS / docs.length));
    const texts = await DocumentChunkRepo.findFullTextsByDocuments(ordered, { maxCharsPerDocument: perDocChars });

    const promptDocs: CrossExamPromptDocument[] = [...handles]
      .filter(([, doc]) => texts.has(doc.id))
      .map(([handle, doc]) => ({ handle, name: doc.name, text: texts.get(doc.id)! }));
    if (promptDocs.length === 0) throw new HttpError("This case's documents have no readable text yet.", 400);

    const side = (docId: string, page: number | null, excerpt: string) =>
      `${handleById.get(docId) ?? "another document"}${page ? ` p.${page}` : ""} "${clip(excerpt)}"`;
    const contradictions = touching.map(
      (c) => `${side(c.leftDocumentId, c.leftPage ?? null, c.leftExcerpt)} vs ${side(c.rightDocumentId, c.rightPage ?? null, c.rightExcerpt)}`,
    );
    const rationale = Array.isArray(witness.aiRationale) ? (witness.aiRationale as { text?: unknown }[]) : [];
    const credibilityPoints = rationale.map((r) => (typeof r?.text === "string" ? r.text : "")).filter(Boolean);

    const buildPrompt = getCrossExaminationPromptBuilder(tenantCode);
    const prompt = buildPrompt(
      {
        caseName: snapshot.case.caseName,
        witness: { name: witness.name, role: witness.role, summary: witness.summary },
        documents: promptDocs,
        contradictions,
        credibilityPoints,
      },
      ukJurisdiction,
    );

    // Streaming WS path, not the blocking REST call — same reason as WitnessScoringSvc (Cloudflare 524).
    // One trace run for both attempts: a retry on a fresh session adds to the same entry in the AI Reasoning pane.
    const trace = newTraceRun("crossExamination", caseId, userId);
    let sessionId = await getChatWonderSessionId();
    let result: { content: string };
    try {
      result = await streamChatWonderMessage(sessionId, prompt, () => {}, undefined, undefined, undefined, tenantCode, undefined, undefined, undefined, { skipLegalVerify: true, trace });
    } catch {
      sessionId = await getChatWonderSessionId();
      result = await streamChatWonderMessage(sessionId, prompt, () => {}, undefined, undefined, undefined, tenantCode, undefined, undefined, undefined, { skipLegalVerify: true, trace });
    }

    const parsed = extractCrossExamination(String(result.content || ""));
    // An unparseable reply leaves the witness with the questions they already had.
    if (!parsed) {
      logger.warn("Cross-examination: unparseable reply, keeping existing questions", { caseId, witnessId });
      return CrossExamRepo.listByWitness(caseId, witnessId);
    }

    // Only a question whose passage is in the text the model was shown, in the document it named.
    const verified = parsed.flatMap((item) => {
      const doc = handles.get(item.documentHandle);
      const text = doc && texts.get(doc.id);
      return doc && text && quoteAppearsIn(item.quote, text) ? [{ item, doc }] : [];
    });

    const pagesByDoc = new Map<string, { pageNumber: number | null; text: string }[]>();
    for (const { doc } of verified) {
      if (!pagesByDoc.has(doc.id)) pagesByDoc.set(doc.id, await DocumentChunkRepo.findPagedTextsByDocument(doc.id, perDocChars));
    }

    const rows: AiCrossExamRow[] = [];
    for (let i = 0; i < verified.length; i += JEV_BATCH) {
      const batch = verified.slice(i, i + JEV_BATCH);
      const checks = await Promise.all(
        batch.map(({ item, doc }) =>
          checkCrossExamSupportWithJev({ question: item.question, quote: item.quote, documentName: doc.name }),
        ),
      );
      batch.forEach(({ item, doc }, j) =>
        rows.push({
          topic: item.topic,
          question: item.question,
          purpose: item.purpose,
          sourceDocumentId: doc.id,
          sourceQuote: item.quote,
          pageNumber: pageOfQuote(pagesByDoc.get(doc.id) ?? [], item.quote),
          supportVerdict: checks[j].verdict,
          supportConfidence: checks[j].confidence,
        }),
      );
    }

    logger.info("Cross-examination questions", {
      caseId,
      witnessId,
      documentCount: promptDocs.length,
      proposed: parsed.length,
      quoteVerified: verified.length,
      droppedUnverified: parsed.length - verified.length,
    });
    const saved = await CrossExamRepo.replaceAiQuestions(caseId, witnessId, rows);
    await OrganizationRepo.writeAudit({
      caseId,
      actorId: userId,
      action: "witness.cross_exam.generate",
      payload: { witnessId, count: rows.length, dropped: parsed.length - verified.length },
    });
    return saved;
  }
}
