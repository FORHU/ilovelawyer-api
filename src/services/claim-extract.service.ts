import CaseAccess from "../utils/case-access";
import CaseRepo from "../repositories/case.repository";
import DocumentRepo from "../repositories/document.repository";
import DocumentChunkRepo from "../repositories/document-chunk.repository";
import CaseClaimRepo from "../repositories/case-claim.repository";
import OrganizationRepo from "../repositories/organization.repository";
import AiGenerationLockSvc from "./ai-generation-lock.service";
import CaseGraphSvc from "./case-graph.service";
import { getClaimExtractPromptBuilder } from "../legal/prompt-registry";
import { getChatWonderSessionId, streamChatWonderMessage } from "../utils/chatWonder";
import { claimTitleKey, extractClaims } from "../utils/claim-extract-parse";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";

// Pleadings are what name the claims, and a case rarely has many; one call reads this many READY
// documents, oldest first (the complaint is usually uploaded before the evidence).
const MAX_DOCS = 10;
const MAX_DOC_CHARS = 12000;
const MAX_TOTAL_DOC_CHARS = 60000;

/**
 * The case's pleaded claims (CaseClaim) — the "grounds" the Citation Map attaches authorities to.
 * Lawyer-triggered from the Citation Map ("Find claims"), queued as AiGenerationQueue kind
 * "claimExtract". Same shape as WitnessExtractSvc: verifiable by construction (every AI claim
 * carries the document and a verbatim quote extractClaims found in that document's text) and
 * additive only — it never edits or deletes a claim, and skips titles already on the case.
 */
export default class ClaimExtractSvc {
  /** Fast half of the queued action — access check + claiming the job row, so a 403/409 surfaces
   * before the enqueue. */
  static async beginQueued(caseId: string, userId: string): Promise<void> {
    await CaseAccess.assertCanEdit(caseId, userId);
    await AiGenerationLockSvc.begin(caseId, "claimExtract");
  }

  /** Run by AiGenerationQueue's worker after beginQueued has claimed the job row. */
  static async runQueued(caseId: string, userId: string): Promise<void> {
    await AiGenerationLockSvc.finishWith(caseId, "claimExtract", () => ClaimExtractSvc.extract(caseId, userId));
  }

  private static async extract(caseId: string, userId: string): Promise<string[]> {
    const docs = (await DocumentRepo.listAllByCase(caseId))
      .filter((d) => d.ragStatus === "READY")
      .reverse()
      .slice(0, MAX_DOCS);
    if (docs.length === 0) return [];

    const tenantCode = await CaseAccess.resolveTenantCode(caseId);
    const header = await CaseRepo.findPromptHeader(caseId);
    const fullTexts = await DocumentChunkRepo.findFullTextsByDocuments(docs.map((d) => d.id));
    const perDocChars = Math.max(1000, Math.min(MAX_DOC_CHARS, Math.floor(MAX_TOTAL_DOC_CHARS / docs.length)));
    const existing = await CaseClaimRepo.list(caseId);

    const prompt = getClaimExtractPromptBuilder(tenantCode)({
      caseName: header?.caseName ?? "Untitled case",
      actionType: header?.actionType,
      jurisdiction: header?.jurisdiction,
      ukJurisdiction: header?.ukJurisdiction,
      existingClaims: existing.map((c) => c.title),
      documents: docs.map((d) => ({ id: d.id, name: d.name, text: (fullTexts.get(d.id) ?? "").slice(0, perDocChars) })),
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

    // Quotes are checked against the full text, not the clipped prompt copy — see WitnessExtractSvc.
    const found = extractClaims(result.content, fullTexts);
    if (found === undefined) throw new HttpError("Chat Wonder returned no [CLAIMS] block", 502);

    const nameOf = new Map(docs.map((d) => [d.id, d.name]));
    const knownKeys = new Set(existing.map((c) => claimTitleKey(c.title)));
    const created: string[] = [];
    for (const claim of found.filter((c) => !knownKeys.has(claimTitleKey(c.title)))) {
      const row = await CaseClaimRepo.createFromAi(caseId, {
        title: claim.title,
        causeOfAction: claim.causeOfAction,
        sourceLabel: nameOf.get(claim.documentId) ?? "Unknown document",
        sourceQuote: claim.quote,
      });
      await CaseGraphSvc.ensureNode(caseId, "CLAIM", row.id);
      created.push(row.id);
    }

    logger.info("Claim extract: done", { caseId, docCount: docs.length, proposed: found.length, created: created.length });
    if (created.length > 0) {
      await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "claim.extract", payload: { ids: created } });
    }
    return created;
  }
}
