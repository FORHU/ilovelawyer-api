import CaseAccess from "../utils/case-access";
import CaseRepo from "../repositories/case.repository";
import DocumentRepo from "../repositories/document.repository";
import DocumentChunkRepo from "../repositories/document-chunk.repository";
import DamageClaimRepo from "../repositories/damage-claim.repository";
import CaseFindingRepo from "../repositories/case-finding.repository";
import OrganizationRepo from "../repositories/organization.repository";
import AiGenerationLockSvc from "./ai-generation-lock.service";
import CaseGraphSvc from "./case-graph.service";
import DamageClaimSvc from "./damage-claim.service";
import { getDamagesExtractPromptBuilder } from "../legal/prompt-registry";
import { getChatWonderSessionId, streamChatWonderMessage } from "../utils/chatWonder";
import { damageHeadKey, extractDamageHeads } from "../utils/damages-extract-parse";
import { DamageJevContext, DamageJevHead, verifyDamageHeadsWithJev } from "../utils/damages-jev";
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
 * Proposes heads for the Damages & Remedies model from the case's documents: payslip rates,
 * amounts a pleading prays for, a percentage asked as attorney's fees. Runs after document
 * extraction settles (runCasePostExtraction schedules it next to the witness pass) and on the
 * panel's "Propose from documents" button. AiGenerationQueue kind "damagesExtract" is the only
 * way it runs; runQueued claims its own lock.
 *
 * Verifiable by construction, same as WitnessExtractSvc: every head carries the document it came
 * from and a verbatim quote that extractDamageHeads has found in that document's text, holding
 * every figure the head uses. The model proposes inputs only — DamageClaimSvc.recompute does the
 * arithmetic. Additive only: it never edits or deletes a head, skips heads the case already has,
 * and marks each document read (Document.damagesExtractedAt) so a head the lawyer removed isn't
 * re-created from the same document. New heads are PROVISIONAL until a lawyer says otherwise.
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
   * documents were read before this pass existed or whose heads the lawyer wants re-proposed.
   * Heads already on the case are still skipped. 409 while a pass is running.
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

    const prompt = getDamagesExtractPromptBuilder(tenantCode)({
      caseName: header?.caseName ?? "Untitled case",
      actionType: header?.actionType,
      jurisdiction: header?.jurisdiction,
      ukJurisdiction: header?.ukJurisdiction,
      existingHeads: existing.map((h) => (h.label ? `${h.category} — ${h.label}` : h.category)),
      documents: batch.map((d) => ({ id: d.id, name: d.name, text: (fullTexts.get(d.id) ?? "").slice(0, perDocChars) })),
    });

    // Streaming WS path (not the blocking REST call — same reason as RedTeamSvc, Cloudflare 524),
    // under chat-wonder's tool-free [extract] persona, settling as soon as the answer ends.
    const call = (sessionId: string) =>
      streamChatWonderMessage(sessionId, prompt, () => {}, undefined, undefined, undefined, tenantCode, undefined, undefined, undefined, {
        resolveOnAnswerEnd: true,
        extract: true,
      });
    let result: { content: string };
    try {
      result = await call(await getChatWonderSessionId());
    } catch {
      result = await call(await getChatWonderSessionId());
    }

    // Quotes are checked against the full text, not the clipped prompt copy — same as witnesses.
    const found = extractDamageHeads(result.content, fullTexts);
    // Documents stay unmarked on an unparseable reply, so the next run reads them again.
    if (found === undefined) throw new HttpError("Chat Wonder returned no [DAMAGES] block", 502);

    const knownKeys = new Set(existing.map((h) => damageHeadKey(h.category, h.label)));
    const fresh = found.filter((h) => !knownKeys.has(damageHeadKey(h.category, h.label)));
    const created = [];
    for (const h of fresh) {
      const row = await DamageClaimRepo.createFromAi(caseId, {
        category: h.category,
        label: h.label,
        basis: h.basis,
        amount: h.amount,
        legalBasis: h.legalBasis,
        pendingEvidence: h.pendingEvidence,
        sourceDocumentId: h.documentId,
        sourceQuote: h.quote,
      });
      await CaseGraphSvc.ensureNode(caseId, "DAMAGE_CLAIM", row.id);
      created.push(row);
    }
    await DocumentRepo.markDamagesExtracted(batch.map((d) => d.id));

    if (created.length > 0) {
      // Computed heads (a rate × period, a percentage) get their amount, and existing attorney's
      // fees move if a new base head arrived.
      await DamageClaimSvc.recompute(caseId);
      await DamagesExtractSvc.rateWithJev(caseId, created.map((r) => r.id));
      await OrganizationRepo.writeAudit({
        caseId,
        actorId: userId,
        action: "damage.extract",
        payload: { ids: created.map((r) => r.id), documentIds: batch.map((d) => d.id) },
      });
    }

    logger.info("Damages extract: batch done", {
      caseId,
      docCount: batch.length,
      proposed: found.length,
      created: created.length,
      remaining: pending.length - batch.length,
    });
    return pending.length > batch.length;
  }

  /**
   * The "damages" step of the case refresh (CaseRefreshSvc.refreshInner), run after findings and
   * outlook: recompute every head, then re-rate all of them with Jev, since awardability reads
   * the findings that refresh just rewrote. New documents are handled by the extraction pass
   * itself, which runCasePostExtraction schedules separately.
   */
  static async refreshStep(caseId: string): Promise<{ heads: number; rated: number }> {
    await DamageClaimSvc.recompute(caseId);
    const heads = await DamageClaimRepo.list(caseId);
    const rated = await DamagesExtractSvc.rateWithJev(caseId, heads.map((h) => h.id));
    return { heads: heads.length, rated };
  }

  /** Jev's second opinion on the given heads, saved to their jev* columns. No-op when
   * USE_JEV_DAMAGES is off. Returns how many heads were rated. */
  private static async rateWithJev(caseId: string, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const [rows, findings] = await Promise.all([DamageClaimRepo.list(caseId), CaseFindingRepo.list(caseId)]);
    const heads: DamageJevHead[] = rows
      .filter((r) => ids.includes(r.id))
      .map((r) => ({ id: r.id, category: r.category, label: r.label, amount: r.amount, basis: r.basis, sourceQuote: r.sourceQuote }));
    const byCategory = (c: string) => findings.filter((f) => f.category === c).map((f) => f.label);
    const context: DamageJevContext = {
      legalIssues: byCategory("LEGAL_ISSUE"),
      strengths: byCategory("STRENGTH"),
      weaknesses: byCategory("WEAKNESS"),
    };
    const ratings = await verifyDamageHeadsWithJev(heads, context);
    for (const [id, r] of ratings) {
      await DamageClaimRepo.saveJev(id, caseId, {
        jevSupport: r.support,
        jevAwardability: r.awardability,
        jevConfidence: r.confidence,
      });
    }
    return ratings.size;
  }
}
