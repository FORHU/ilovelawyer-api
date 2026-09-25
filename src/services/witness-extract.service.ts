import CaseAccess from "../utils/case-access";
import CaseRepo from "../repositories/case.repository";
import DocumentRepo from "../repositories/document.repository";
import DocumentChunkRepo from "../repositories/document-chunk.repository";
import WitnessRepo from "../repositories/witness.repository";
import OrganizationRepo from "../repositories/organization.repository";
import AiGenerationLockSvc from "./ai-generation-lock.service";
import CaseGraphSvc from "./case-graph.service";
import { getWitnessExtractPromptBuilder } from "../legal/prompt-registry";
import { getChatWonderSessionId, streamChatWonderMessage } from "../utils/chatWonder";
import { extractWitnesses, witnessNameKey } from "../utils/witness-extract-parse";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";

// One Chat Wonder call reads at most this many new documents; anything left over is picked up by
// a follow-up job this one enqueues, so a large upload is worked through in bounded batches.
const MAX_DOCS_PER_RUN = 8;
const MAX_DOC_CHARS = 12000;
const MAX_TOTAL_DOC_CHARS = 60000;
// Backoff before retrying when another witnessExtract run for the case still holds the lock.
const BUSY_RETRY_SECONDS = 30;

/**
 * Automatic witness list: after document extraction settles (runCasePostExtraction), reads each
 * READY document it hasn't read before and adds the people in it as Witness rows with
 * source=AI. No controller or button — AiGenerationQueue kind "witnessExtract" is the only
 * entry point, and runQueued claims its own lock the way casePostExtraction does.
 *
 * Verifiable by construction: every row carries the document it came from and a verbatim quote
 * that extractWitnesses has already found in that document's text. Additive only — it never
 * edits or deletes an existing witness, skips names already on the case, and marks each document
 * as read (Document.witnessesExtractedAt) so a witness the lawyer removed isn't re-created from
 * the same document on the next run.
 */
export default class WitnessExtractSvc {
  static schedule(caseId: string, userId: string, delaySeconds?: number): void {
    void (async () => {
      try {
        // Dynamic import — ai-generation.queue.ts imports this service for its RUNNERS table.
        const AiGenerationQueue = (await import("../queues/ai-generation.queue")).default;
        AiGenerationQueue.enqueue({ kind: "witnessExtract", caseId, userId }, delaySeconds);
      } catch (err) {
        logger.error("Witness extract: failed to enqueue", { err, caseId, userId });
      }
    })();
  }

  /** Run by AiGenerationQueue's worker. */
  static async runQueued(caseId: string, userId: string): Promise<void> {
    if (!(await CaseRepo.exists(caseId))) return;
    if ((await DocumentRepo.listPendingWitnessExtraction(caseId)).length === 0) return;

    try {
      await AiGenerationLockSvc.begin(caseId, "witnessExtract");
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 409) {
        logger.info("Witness extract: already running for case, rescheduling", { caseId });
        WitnessExtractSvc.schedule(caseId, userId, BUSY_RETRY_SECONDS);
        return;
      }
      throw err;
    }

    const hasMore = await AiGenerationLockSvc.finishWith(caseId, "witnessExtract", () =>
      WitnessExtractSvc.extractBatch(caseId, userId),
    );
    if (hasMore) WitnessExtractSvc.schedule(caseId, userId);
  }

  /** Returns true when READY documents are still waiting after this batch. */
  private static async extractBatch(caseId: string, userId: string): Promise<boolean> {
    const pending = await DocumentRepo.listPendingWitnessExtraction(caseId);
    const batch = pending.slice(0, MAX_DOCS_PER_RUN);
    if (batch.length === 0) return false;

    const tenantCode = await CaseAccess.resolveTenantCode(caseId);
    const header = await CaseRepo.findPromptHeader(caseId);
    const fullTexts = await DocumentChunkRepo.findFullTextsByDocuments(batch.map((d) => d.id));
    const perDocChars = Math.max(1000, Math.min(MAX_DOC_CHARS, Math.floor(MAX_TOTAL_DOC_CHARS / batch.length)));
    const existing = await WitnessRepo.list(caseId);

    const prompt = getWitnessExtractPromptBuilder(tenantCode)({
      caseName: header?.caseName ?? "Untitled case",
      actionType: header?.actionType,
      jurisdiction: header?.jurisdiction,
      ukJurisdiction: header?.ukJurisdiction,
      existingWitnesses: existing.map((w) => w.name),
      documents: batch.map((d) => ({ id: d.id, name: d.name, text: (fullTexts.get(d.id) ?? "").slice(0, perDocChars) })),
    });

    // Streaming WS path, not the blocking REST call — same reason as RedTeamSvc (Cloudflare 524).
    let sessionId = await getChatWonderSessionId();
    let result: { content: string };
    try {
      result = await streamChatWonderMessage(sessionId, prompt, () => {}, undefined, undefined, undefined, tenantCode);
    } catch {
      sessionId = await getChatWonderSessionId();
      result = await streamChatWonderMessage(sessionId, prompt, () => {}, undefined, undefined, undefined, tenantCode);
    }

    // Quotes are checked against the full text, not the clipped prompt copy — a quote the model
    // could only have seen in the clipped part is still found; one it made up never is.
    const found = extractWitnesses(result.content, fullTexts);
    // Documents stay unmarked on an unparseable reply, so the next run reads them again.
    if (found === undefined) throw new HttpError("Chat Wonder returned no [WITNESSES] block", 502);

    const knownKeys = new Set(existing.map((w) => witnessNameKey(w.name)));
    const fresh = found.filter((w) => !knownKeys.has(witnessNameKey(w.name)));
    const created = [];
    for (const w of fresh) {
      const row = await WitnessRepo.createFromAi(caseId, {
        name: w.name,
        role: w.role,
        summary: w.summary,
        sourceDocumentId: w.documentId,
        sourceQuote: w.quote,
      });
      await CaseGraphSvc.ensureNode(caseId, "WITNESS", row.id);
      created.push(row.id);
    }
    await DocumentRepo.markWitnessesExtracted(batch.map((d) => d.id));

    logger.info("Witness extract: batch done", {
      caseId,
      docCount: batch.length,
      proposed: found.length,
      created: created.length,
      remaining: pending.length - batch.length,
    });
    if (created.length > 0) {
      await OrganizationRepo.writeAudit({
        caseId,
        actorId: userId,
        action: "witness.extract",
        payload: { ids: created, documentIds: batch.map((d) => d.id) },
      });
    }
    return pending.length > batch.length;
  }
}
