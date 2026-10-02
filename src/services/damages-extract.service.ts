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
import { damageHeadKey, extractDamageHeads } from "../utils/damages-extract-parse";
import { quotedFigureOf, vetDamageHeads } from "../utils/damages-jev";
import { buildDamagesCorrectionPrompt } from "../constants/damages-extract.constants";
import type { TenantCode } from "../types/tenant-code";
import type { ExtractedDamageHead } from "../utils/damages-extract-parse";
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
 * amount. It never edits or deletes an entry, and skips any the case already has (same kind and
 * title). Each document is marked read (Document.damagesExtractedAt) so an entry the lawyer
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

    const prompt = getDamagesExtractPromptBuilder(tenantCode)({
      caseName: header?.caseName ?? "Untitled case",
      actionType: header?.actionType,
      jurisdiction: header?.jurisdiction,
      ukJurisdiction: header?.ukJurisdiction,
      existingHeads: existing.map((h) => `${h.kind} — ${h.title}${h.amount != null ? `: ${h.amount}` : ""}`),
      documents: batch.map((d) => ({ id: d.id, name: d.name, text: (fullTexts.get(d.id) ?? "").slice(0, perDocChars) })),
    });

    const result = await DamagesExtractSvc.ask(prompt, tenantCode);

    // Quotes are checked against the full text, not the clipped prompt copy — same as witnesses.
    const proposed = extractDamageHeads(result.content, fullTexts);
    // Documents stay unmarked on an unparseable reply, so the next run reads them again.
    if (proposed === undefined) throw new HttpError("Chat Wonder returned no [DAMAGES] block", 502);
    // Jev reviews every proposal before anything is saved; a rejected figure goes back to Chat
    // Wonder once for the right one (or is dropped), so nothing questionable reaches the panel.
    const found = await DamagesExtractSvc.vetWithJev(caseId, proposed, {
      tenantCode,
      fullTexts,
      documents: batch.map((d) => ({ id: d.id, name: d.name, text: (fullTexts.get(d.id) ?? "").slice(0, perDocChars) })),
    });

    const known = new Set(existing.map((h) => damageHeadKey(h.kind, h.title)));
    const fresh = found.filter((h) => !known.has(damageHeadKey(h.kind, h.title)));
    const created = [];
    for (const h of fresh) {
      const row = await DamageClaimRepo.createFromAi(caseId, {
        kind: h.kind,
        title: h.title,
        description: h.description,
        amount: h.amount,
        sourceDocumentId: h.documentId,
        sourceQuote: h.quote,
      });
      await CaseGraphSvc.ensureNode(caseId, "DAMAGE_CLAIM", row.id);
      created.push(row);
    }
    await DocumentRepo.markDamagesExtracted(batch.map((d) => d.id));

    if (created.length > 0) {
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
      proposed: proposed.length,
      kept: found.length,
      created: created.length,
      remaining: pending.length - batch.length,
    });
    return pending.length > batch.length;
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
    ctx: { tenantCode: TenantCode; fullTexts: Map<string, string>; documents: { id: string; name: string; text: string }[] },
  ): Promise<ExtractedDamageHead[]> {
    const first = await vetDamageHeads(proposed);
    if (first.rejected.length === 0) return first.accepted;

    const rejectedKeys = new Set(first.rejected.map((r) => damageHeadKey(r.head.kind, r.head.title)));
    const citedDocs = new Set(first.rejected.map((r) => r.head.documentId));
    let corrected: ExtractedDamageHead[] = [];
    try {
      const prompt = buildDamagesCorrectionPrompt({
        rejected: first.rejected.map(({ head, check }) => ({
          kind: head.kind,
          title: head.title,
          figure: quotedFigureOf(head.amount) ?? "",
          quote: head.quote,
          documentId: head.documentId,
          reason: check.verdict === "CONTRADICTED" ? "CONTRADICTED" : "UNSUPPORTED",
        })),
        documents: ctx.documents.filter((d) => citedDocs.has(d.id)),
      });
      const reply = await DamagesExtractSvc.ask(prompt, ctx.tenantCode);
      corrected = (extractDamageHeads(reply.content, ctx.fullTexts) ?? []).filter((h) =>
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
