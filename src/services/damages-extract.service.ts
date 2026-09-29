import CaseAccess from "../utils/case-access";
import CaseRepo from "../repositories/case.repository";
import DocumentRepo from "../repositories/document.repository";
import DocumentChunkRepo from "../repositories/document-chunk.repository";
import DamageClaimRepo from "../repositories/damage-claim.repository";
import OrganizationRepo from "../repositories/organization.repository";
import AiGenerationLockSvc from "./ai-generation-lock.service";
import CaseGraphSvc from "./case-graph.service";
import DamageClaimSvc from "./damage-claim.service";
import { getDamagesExtractPromptBuilder } from "../legal/prompt-registry";
import { getChatWonderSessionId, streamChatWonderMessage } from "../utils/chatWonder";
import { damageHeadKey, extractDamageHeads } from "../utils/damages-extract-parse";
import { checkPendingEvidence, quotedFigureOf, vetDamageHeads } from "../utils/damages-jev";
import { buildDamagesCorrectionPrompt } from "../constants/damages-extract.constants";
import type { TenantCode } from "../types/tenant-code";
import { describeDamageBasis } from "../utils/damages-compute";
import { figuresDiffer, mergeProposedBasis, parseDamageProposal, type DamageProposal } from "../utils/damages-proposal";
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
 * Proposes heads for the Damages & Remedies model from the case's documents: payslip rates,
 * amounts a pleading prays for, a percentage asked as attorney's fees. Runs after document
 * extraction settles (runCasePostExtraction schedules it next to the witness pass) and on the
 * panel's "Propose from documents" button. AiGenerationQueue kind "damagesExtract" is the only
 * way it runs; runQueued claims its own lock.
 *
 * Verifiable by construction, same as WitnessExtractSvc: every head carries the document it came
 * from and a verbatim quote that extractDamageHeads has found in that document's text, holding
 * every figure the head uses. The model proposes inputs only — DamageClaimSvc.recompute does the
 * arithmetic. It never edits or deletes a head: a figure for a head the case already has is stored
 * as a suggested update (proposeUpdate) for the lawyer to apply or dismiss. Each document is marked
 * read (Document.damagesExtractedAt) so a head the lawyer removed isn't re-created from the same
 * document. New heads are PROVISIONAL until a lawyer says otherwise.
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
   * Heads already on the case are never duplicated (see proposeUpdate). 409 while a pass is running.
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
      existingHeads: existing.map((h) => {
        const name = h.label ? `${h.category} — ${h.label}` : h.category;
        const figures = describeDamageBasis(h.basis) ?? (h.amount != null ? String(h.amount) : null);
        return figures ? `${name}: ${figures}` : name;
      }),
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

    const byKey = new Map(existing.map((h) => [damageHeadKey(h.category, h.label), h]));
    const fresh = found.filter((h) => !byKey.has(damageHeadKey(h.category, h.label)));
    // A figure for a head the case already has becomes a suggested update, never an edit.
    const docById = new Map(batch.map((d) => [d.id, d]));
    const proposedIds: string[] = [];
    for (const h of found) {
      const row = byKey.get(damageHeadKey(h.category, h.label));
      const doc = docById.get(h.documentId);
      if (!row || !doc) continue;
      const proposed = await DamagesExtractSvc.proposeUpdate(caseId, row, h, {
        name: doc.name,
        category: (doc as { category?: string | null }).category ?? null,
        text: fullTexts.get(doc.id) ?? null,
      });
      if (proposed) proposedIds.push(row.id);
    }
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
      await OrganizationRepo.writeAudit({
        caseId,
        actorId: userId,
        action: "damage.extract",
        payload: { ids: created.map((r) => r.id), documentIds: batch.map((d) => d.id) },
      });
    }

    if (proposedIds.length > 0) {
      await OrganizationRepo.writeAudit({
        caseId,
        actorId: userId,
        action: "damage.propose-update",
        payload: { ids: proposedIds, documentIds: batch.map((d) => d.id) },
      });
    }

    logger.info("Damages extract: batch done", {
      caseId,
      docCount: batch.length,
      proposed: proposed.length,
      kept: found.length,
      created: created.length,
      updatesProposed: proposedIds.length,
      remaining: pending.length - batch.length,
    });
    return pending.length > batch.length;
  }

  /**
   * Offers `found` as an update to the head `row` when the document says something new: different
   * figures, or — for a head still waiting on evidence — the very evidence it was waiting on
   * (checkPendingEvidence), in which case applying the update also certifies it. Stored in
   * aiProposedBasis; the head itself is never touched. Returns whether a proposal was written.
   */
  static async proposeUpdate(
    caseId: string,
    row: { id: string; basis: unknown; amount: number | null; status: string; pendingEvidence: string | null; aiProposedBasis?: unknown },
    found: ExtractedDamageHead,
    doc: { name: string; category: string | null; text: string | null },
  ): Promise<boolean> {
    const differ = figuresDiffer(row, found);
    const waitingOn = row.status !== "CERTIFIED" && row.pendingEvidence ? row.pendingEvidence : null;
    const satisfiesPending = waitingOn ? await checkPendingEvidence(waitingOn, doc) : null;
    if (!differ && satisfiesPending !== true) return false;

    const proposal: DamageProposal = {
      basis: mergeProposedBasis(row.basis, found.basis),
      amount: found.basis.kind === "FIXED" ? found.amount : null,
      sourceDocumentId: found.documentId,
      documentName: doc.name,
      sourceQuote: found.quote,
      satisfiesPending,
      proposedAt: new Date().toISOString(),
    };
    const current = parseDamageProposal(row.aiProposedBasis);
    if (
      current &&
      current.sourceDocumentId === proposal.sourceDocumentId &&
      JSON.stringify(current.basis) === JSON.stringify(proposal.basis) &&
      current.amount === proposal.amount
    ) {
      return false;
    }
    await DamageClaimRepo.setProposal(row.id, caseId, proposal);
    return true;
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

    const rejectedKeys = new Set(first.rejected.map((r) => damageHeadKey(r.head.category, r.head.label)));
    const citedDocs = new Set(first.rejected.map((r) => r.head.documentId));
    let corrected: ExtractedDamageHead[] = [];
    try {
      const prompt = buildDamagesCorrectionPrompt({
        rejected: first.rejected.map(({ head, check }) => ({
          category: head.category,
          label: head.label,
          figure: quotedFigureOf(head.basis, head.amount) ?? "",
          quote: head.quote,
          documentId: head.documentId,
          reason: check.verdict === "CONTRADICTED" ? "CONTRADICTED" : "UNSUPPORTED",
        })),
        documents: ctx.documents.filter((d) => citedDocs.has(d.id)),
      });
      const reply = await DamagesExtractSvc.ask(prompt, ctx.tenantCode);
      corrected = (extractDamageHeads(reply.content, ctx.fullTexts) ?? []).filter((h) =>
        rejectedKeys.has(damageHeadKey(h.category, h.label)),
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
   * The "damages" step of the case refresh (CaseRefreshSvc.refreshInner): recompute every head, so
   * figures that accrue to today and derived heads (attorney's fees) are current. New documents are
   * handled by the extraction pass itself, which runCasePostExtraction schedules separately.
   */
  static async refreshStep(caseId: string): Promise<{ heads: number }> {
    await DamageClaimSvc.recompute(caseId);
    const heads = await DamageClaimRepo.list(caseId);
    return { heads: heads.length };
  }
}
