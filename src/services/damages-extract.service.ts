import CaseAccess from "../utils/case-access";
import CaseRepo from "../repositories/case.repository";
import DocumentRepo from "../repositories/document.repository";
import DocumentChunkRepo from "../repositories/document-chunk.repository";
import DamageClaimRepo from "../repositories/damage-claim.repository";
import OrganizationRepo from "../repositories/organization.repository";
import AiGenerationLockSvc from "./ai-generation-lock.service";
import CaseGraphSvc from "./case-graph.service";
import { getDamagesExtractPromptBuilder } from "../legal/prompt-registry";
import { getChatWonderSessionId, streamChatWonderMessage } from "../utils/chatWonder";
import { damageHeadKey, extractDamageHeads, parseDamageEstimates } from "../utils/damages-extract-parse";
import { quotedFigureOf, vetDamageHeads } from "../utils/damages-jev";
import { buildDamagesCorrectionPrompt, buildDamagesEstimatePrompt } from "../constants/damages-extract.constants";
import type { TenantCode } from "../types/tenant-code";
import type { ExtractedDamageHead } from "../utils/damages-extract-parse";
import type { CaseDoc } from "../utils/case-document-handles";
import { isJobStale } from "../utils/ai-generation-lock.utils";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";

// Same bounds as WitnessExtractSvc: one Chat Wonder call reads at most this many new documents,
// and a follow-up job picks up the rest.
const MAX_DOCS_PER_RUN = 8;
const MAX_DOC_CHARS = 12000;
const MAX_TOTAL_DOC_CHARS = 60000;
// Backoff before retrying when another damagesExtract run for the case still holds the lock.
const BUSY_RETRY_SECONDS = 30;

/**
 * Proposes Damages & Remedies entries from the case's documents: amounts a pleading prays for, a
 * stated backwages figure, reinstatement asked for. Runs after document extraction settles
 * (runCasePostExtraction schedules it next to the witness pass) and on the panel's "Propose from
 * documents" button. AiGenerationQueue kind "damagesExtract" is the only way it runs; runQueued
 * claims its own lock.
 *
 * Verifiable by construction, same as WitnessExtractSvc: every entry carries the document it came
 * from and a verbatim quote that extractDamageHeads has found in that document's text, holding its
 * amount (or the rate and count it is worked out from). It never deletes an entry and skips any the
 * case already has (same kind and title), except to fill in the amount of an AI suggestion still
 * waiting for the lawyer. Each document is marked read (Document.damagesExtractedAt) so an entry the lawyer
 * removed isn't re-created from the same document. New entries wait for a lawyer to accept them.
 */
export default class DamagesExtractSvc {
  static schedule(caseId: string, userId: string, delaySeconds?: number): void {
    void (async () => {
      try {
        // Dynamic import — ai-generation.queue.ts imports this service for its RUNNERS table.
        const AiGenerationQueue = (await import("../queues/ai-generation.queue")).default;
        AiGenerationQueue.enqueue({ kind: "damagesExtract", caseId, userId }, delaySeconds);
      } catch (err) {
        logger.error("Damages extract: failed to enqueue", { err, caseId, userId });
      }
    })();
  }

  /**
   * POST /:caseId/damages/propose — reads every document of the case again, for cases whose
   * documents were read before this pass existed or whose entries the lawyer wants re-proposed.
   * Entries already on the case are never duplicated. 409 while a pass is running.
   */
  static async propose(caseId: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const current = await AiGenerationLockSvc.getStatus(caseId, "damagesExtract");
    if (current?.status === "IN_PROGRESS" && !isJobStale(current.startedAt)) {
      throw new HttpError("damagesExtract generation is already in progress", 409);
    }
    await DocumentRepo.clearDamagesExtracted(caseId);
    DamagesExtractSvc.schedule(caseId, userId);
    return current;
  }

  /** Run by AiGenerationQueue's worker. */
  static async runQueued(caseId: string, userId: string): Promise<void> {
    if (!(await CaseRepo.exists(caseId))) return;
    if ((await DocumentRepo.listPendingDamagesExtraction(caseId)).length === 0) return;

    try {
      await AiGenerationLockSvc.begin(caseId, "damagesExtract");
    } catch (err) {
      if (err instanceof HttpError && err.statusCode === 409) {
        logger.info("Damages extract: already running for case, rescheduling", { caseId });
        DamagesExtractSvc.schedule(caseId, userId, BUSY_RETRY_SECONDS);
        return;
      }
      throw err;
    }

    const hasMore = await AiGenerationLockSvc.finishWith(caseId, "damagesExtract", () =>
      DamagesExtractSvc.extractBatch(caseId, userId),
    );
    if (hasMore) DamagesExtractSvc.schedule(caseId, userId);
  }

  /** Returns true when READY documents are still waiting after this batch. */
  private static async extractBatch(caseId: string, userId: string): Promise<boolean> {
    const pending = await DocumentRepo.listPendingDamagesExtraction(caseId);
    const batch = pending.slice(0, MAX_DOCS_PER_RUN);
    if (batch.length === 0) return false;

    const tenantCode = await CaseAccess.resolveTenantCode(caseId);
    const header = await CaseRepo.findPromptHeader(caseId);
    const fullTexts = await DocumentChunkRepo.findFullTextsByDocuments(batch.map((d) => d.id));
    const perDocChars = Math.max(1000, Math.min(MAX_DOC_CHARS, Math.floor(MAX_TOTAL_DOC_CHARS / batch.length)));
    const existing = await DamageClaimRepo.list(caseId);
    // The model sees each document under a short handle (D1, D2, …) — long ids come back garbled
    // often enough to drop entries; the parser resolves the handle back to the real id.
    const docs: CaseDoc[] = batch.map((d) => ({ id: d.id, name: d.name }));
    const promptDocs = batch.map((d, i) => ({ id: `D${i + 1}`, name: d.name, text: (fullTexts.get(d.id) ?? "").slice(0, perDocChars) }));

    const prompt = getDamagesExtractPromptBuilder(tenantCode)({
      caseName: header?.caseName ?? "Untitled case",
      actionType: header?.actionType,
      jurisdiction: header?.jurisdiction,
      ukJurisdiction: header?.ukJurisdiction,
      existingHeads: existing.map((h) => `${h.kind} — ${h.title}${h.amount != null ? `: ${h.amount}` : ""}`),
      documents: promptDocs,
    });

    const result = await DamagesExtractSvc.ask(prompt, tenantCode);

    // Quotes are checked against the full text, not the clipped prompt copy — same as witnesses.
    const proposed = extractDamageHeads(result.content, fullTexts, docs);
    // Documents stay unmarked on an unparseable reply, so the next run reads them again.
    if (proposed === undefined) throw new HttpError("Chat Wonder returned no [DAMAGES] block", 502);
    // Jev reviews every proposal before anything is saved; a rejected figure goes back to Chat
    // Wonder once for the right one (or is dropped), so nothing questionable reaches the panel.
    const found = await DamagesExtractSvc.vetWithJev(caseId, proposed, { tenantCode, fullTexts, docs, promptDocs });

    const known = new Map(existing.map((h) => [damageHeadKey(h.kind, h.title), h]));
    // Every AI damage carries a figure: one still without an amount — new from this read, or a
    // waiting suggestion from an earlier one — gets the AI's estimate, asked for in one more call.
    const foundKeys = new Set(found.map((h) => damageHeadKey(h.kind, h.title)));
    const unpricedFound = found.filter((h) => h.kind === "DAMAGE" && h.amount == null);
    const unpricedWaiting = existing.filter(
      (e) => e.kind === "DAMAGE" && e.source === "AI" && !e.accepted && e.amount == null && !foundKeys.has(damageHeadKey(e.kind, e.title)),
    );
    const estimates = await DamagesExtractSvc.estimateMissing(
      caseId,
      [
        ...unpricedFound.map((h) => ({ title: h.title, description: h.description, quote: h.quote })),
        ...unpricedWaiting.map((e) => ({ title: e.title, description: e.description, quote: e.sourceQuote })),
      ],
      { tenantCode, caseName: header?.caseName ?? "Untitled case", venue: tenantCode === "UK" ? header?.ukJurisdiction || "England and Wales" : "the Philippines", promptDocs },
    );
    for (const h of unpricedFound) {
      const estimate = estimates.get(damageHeadKey(h.kind, h.title));
      if (!estimate) continue;
      h.amount = estimate.amount;
      h.amountBasis = "ESTIMATE";
      h.amountNote = estimate.basis;
    }

    const fresh = found.filter((h) => !known.has(damageHeadKey(h.kind, h.title)));
    // A suggestion still waiting for the lawyer takes a better amount a later read found for it: a
    // figure where it had none, or one from the documents in place of an estimate. Accepted
    // entries and the lawyer's own are never touched.
    const filled = [];
    for (const h of found) {
      const prior = known.get(damageHeadKey(h.kind, h.title));
      if (!prior || prior.source !== "AI" || prior.accepted || h.amount == null) continue;
      const better = prior.amount == null || (prior.amountBasis === "ESTIMATE" && h.amountBasis !== "ESTIMATE");
      if (!better) continue;
      filled.push(
        await DamageClaimRepo.fillAiAmount(prior.id, caseId, {
          amount: h.amount,
          amountBasis: h.amountBasis,
          amountNote: h.amountNote,
          description: h.description,
          sourceDocumentId: h.documentId,
          sourceQuote: h.quote,
        }),
      );
    }
    for (const e of unpricedWaiting) {
      const estimate = estimates.get(damageHeadKey(e.kind, e.title));
      if (!estimate || !e.sourceDocumentId || !e.sourceQuote) continue;
      filled.push(
        await DamageClaimRepo.fillAiAmount(e.id, caseId, {
          amount: estimate.amount,
          amountBasis: "ESTIMATE",
          amountNote: estimate.basis,
          description: null,
          sourceDocumentId: e.sourceDocumentId,
          sourceQuote: e.sourceQuote,
        }),
      );
    }
    const created = [];
    for (const h of fresh) {
      const row = await DamageClaimRepo.createFromAi(caseId, {
        kind: h.kind,
        title: h.title,
        description: h.description,
        amount: h.amount,
        amountBasis: h.amountBasis,
        amountNote: h.amountNote,
        sourceDocumentId: h.documentId,
        sourceQuote: h.quote,
      });
      await CaseGraphSvc.ensureNode(caseId, "DAMAGE_CLAIM", row.id);
      created.push(row);
    }
    await DocumentRepo.markDamagesExtracted(batch.map((d) => d.id));

    if (created.length > 0 || filled.length > 0) {
      await OrganizationRepo.writeAudit({
        caseId,
        actorId: userId,
        action: "damage.extract",
        payload: { ids: created.map((r) => r.id), filledIds: filled.map((r) => r.id), documentIds: batch.map((d) => d.id) },
      });
    }

    logger.info("Damages extract: batch done", {
      caseId,
      docCount: batch.length,
      proposed: proposed.length,
      kept: found.length,
      created: created.length,
      filled: filled.length,
      stated: found.filter((h) => h.amountBasis === "STATED" || h.amountBasis === "CALCULATED").length,
      estimated: found.filter((h) => h.amountBasis === "ESTIMATE").length,
      unpriced: found.filter((h) => h.kind === "DAMAGE" && h.amount == null).length,
      remaining: pending.length - batch.length,
    });
    return pending.length > batch.length;
  }

  /** One call for the estimates of every damage in `heads` (see buildDamagesEstimatePrompt), by
   * damageHeadKey. Empty when there is nothing to ask; a failed call is logged and leaves them
   * without an amount rather than failing the batch, and the next read asks again. */
  private static async estimateMissing(
    caseId: string,
    heads: { title: string; description: string | null; quote: string | null }[],
    ctx: { tenantCode: TenantCode; caseName: string; venue: string; promptDocs: { id: string; name: string; text: string }[] },
  ): Promise<Map<string, { amount: number; basis: string }>> {
    if (heads.length === 0) return new Map();
    try {
      const prompt = buildDamagesEstimatePrompt({ caseName: ctx.caseName, venue: ctx.venue, heads, documents: ctx.promptDocs });
      const estimates = parseDamageEstimates((await DamagesExtractSvc.ask(prompt, ctx.tenantCode)).content);
      logger.info("Damages extract: estimates", { caseId, asked: heads.length, got: estimates.size });
      return estimates;
    } catch (err) {
      logger.warn("Damages extract: estimate request failed, leaving those damages without an amount", { err, caseId });
      return new Map();
    }
  }

  /** One question to Chat Wonder over the streaming WS path (not the blocking REST call — same
   * reason as RedTeamSvc, Cloudflare 524), on the legal persona like every other extraction job.
   * Same options as CaseMindMapSvc's document-built map, whose reply is also machine-readable:
   * resolveOnAnswerEnd skips the post-answer extras (timeline, map, reasoning) this call never uses,
   * and skipLegalVerify skips the quotation/contradiction audit, which would only add a rewrite
   * round to a [DAMAGES] block. Retried once on a fresh session. */
  private static async ask(prompt: string, tenantCode: TenantCode): Promise<{ content: string }> {
    const call = (sessionId: string) =>
      streamChatWonderMessage(sessionId, prompt, () => {}, undefined, undefined, undefined, tenantCode, undefined, undefined, undefined, {
        resolveOnAnswerEnd: true,
        skipLegalVerify: true,
      });
    try {
      return await call(await getChatWonderSessionId());
    } catch {
      return call(await getChatWonderSessionId());
    }
  }

  /**
   * Jev reads each proposed head's quote and says whether it states the figure taken from it
   * (vetDamageHeads). Heads it rejects are sent back to Chat Wonder once, with the reason, asking
   * for the right figure and the line that states it — or to leave the head out. The answer goes
   * through the same parser checks and Jev again; only heads Jev accepts (or can't judge) are kept.
   * A failed follow-up drops the rejected heads rather than failing the batch. With
   * USE_JEV_DAMAGES off, every proposal is kept as the parser left it.
   */
  static async vetWithJev(
    caseId: string,
    proposed: ExtractedDamageHead[],
    ctx: {
      tenantCode: TenantCode;
      fullTexts: Map<string, string>;
      /** The batch's documents by real id, in handle order. */
      docs: CaseDoc[];
      /** The same documents as the prompt shows them: handle, name, clipped text. */
      promptDocs: { id: string; name: string; text: string }[];
    },
  ): Promise<ExtractedDamageHead[]> {
    const first = await vetDamageHeads(proposed);
    if (first.rejected.length === 0) return first.accepted;

    const rejectedKeys = new Set(first.rejected.map((r) => damageHeadKey(r.head.kind, r.head.title)));
    const handleOf = new Map(ctx.docs.map((d, i) => [d.id, `D${i + 1}`]));
    const citedHandles = new Set(first.rejected.flatMap((r) => r.head.quotes.map((q) => handleOf.get(q.documentId))));
    let corrected: ExtractedDamageHead[] = [];
    try {
      const prompt = buildDamagesCorrectionPrompt({
        rejected: first.rejected.map(({ head, check }) => ({
          kind: head.kind,
          title: head.title,
          figure: head.figure ?? quotedFigureOf(head.amount) ?? "",
          quote: head.quote,
          documentId: handleOf.get(head.documentId) ?? head.documentId,
          reason: check.verdict === "CONTRADICTED" ? "CONTRADICTED" : "UNSUPPORTED",
        })),
        documents: ctx.promptDocs.filter((d) => citedHandles.has(d.id)),
      });
      const reply = await DamagesExtractSvc.ask(prompt, ctx.tenantCode);
      corrected = (extractDamageHeads(reply.content, ctx.fullTexts, ctx.docs) ?? []).filter((h) =>
        rejectedKeys.has(damageHeadKey(h.kind, h.title)),
      );
    } catch (err) {
      logger.warn("Damages extract: correction request failed, dropping rejected heads", { err, caseId });
    }
    const second = await vetDamageHeads(corrected);

    logger.info("Damages extract: Jev review", {
      caseId,
      proposed: proposed.length,
      rejected: first.rejected.length,
      corrected: second.accepted.length,
      dropped: first.rejected.length - second.accepted.length,
    });
    return [...first.accepted, ...second.accepted];
  }

  /**
   * The "damages" step of the case refresh (CaseRefreshSvc.refreshInner). Nothing is computed per
   * entry any more; it reports the entry count. New documents are handled by the extraction pass
   * itself, which runCasePostExtraction schedules separately.
   */
  static async refreshStep(caseId: string): Promise<{ heads: number }> {
    const heads = await DamageClaimRepo.list(caseId);
    return { heads: heads.length };
  }
}
