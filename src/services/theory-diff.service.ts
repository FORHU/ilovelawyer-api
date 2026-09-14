import CaseTheoryRepo from "../repositories/case-theory.repository";
import TheoryDiffRepo from "../repositories/theory-diff.repository";
import EvidenceRepo from "../repositories/evidence.repository";
import CaseAccess from "../utils/case-access";
import OrganizationRepo from "../repositories/organization.repository";
import AiGenerationLockSvc from "./ai-generation-lock.service";
import HttpError from "../utils/http-error";
import { getChatWonderSessionId, streamChatWonderMessage } from "../utils/chatWonder";
import { parseTheoryDiff } from "../utils/theory-parse";

function theoryBlock(label: string, theory: { title: string; thesis: string; claims: { statement: string; stance: string }[]; assumptions: { statement: string }[]; openQuestions: { question: string }[] }): string {
  return `${label}: "${theory.title}"
Thesis: ${theory.thesis}
Claims:
${theory.claims.map((c) => `- (${c.stance}) ${c.statement}`).join("\n") || "(none)"}
Assumptions:
${theory.assumptions.map((a) => `- ${a.statement}`).join("\n") || "(none)"}
Open questions:
${theory.openQuestions.map((q) => `- ${q.question}`).join("\n") || "(none)"}`;
}

/**
 * Reconciles two lawyers' theories of the same case without merging them (differentiation
 * program, Phase 2 — Workstream B): names what they share, what they disagree on, and — for
 * each disagreement — the evidence that would decide it and what's still missing. Never picks
 * a winner; both theories are left exactly as their authors wrote them. See
 * docs/plans/differentiation-program.md.
 */
export default class TheoryDiffSvc {
  static async get(caseId: string, userId: string, theoryAId: string, theoryBId: string) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    return TheoryDiffRepo.get(theoryAId, theoryBId);
  }

  /** Fast, synchronous half of a queued diff — access check + claiming the AiGenerationJob
   * row — mirrors CaseReconstructionSvc.beginQueued/runQueued. One diff generation at a time
   * per case regardless of which pair (AiGenerationLockSvc keys on caseId+kind, not the pair)
   * — acceptable for a lawyer-triggered, low-frequency action. */
  static async beginQueuedDiff(caseId: string, userId: string): Promise<void> {
    await CaseAccess.assertCanEdit(caseId, userId);
    await AiGenerationLockSvc.begin(caseId, "theoryDiff");
  }

  static async runQueuedDiff(caseId: string, userId: string, theoryAId: string, theoryBId: string): Promise<void> {
    await AiGenerationLockSvc.finishWith(caseId, "theoryDiff", () => TheoryDiffSvc.diffInner(caseId, userId, theoryAId, theoryBId));
  }

  private static async diffInner(caseId: string, userId: string, theoryAId: string, theoryBId: string) {
    const tenantCode = await CaseAccess.resolveTenantCode(caseId);
    const [theoryA, theoryB] = await Promise.all([
      CaseTheoryRepo.findById(theoryAId, caseId),
      CaseTheoryRepo.findById(theoryBId, caseId),
    ]);
    if (!theoryA || !theoryB) throw new HttpError("Both theories must belong to this case", 404);

    const contradictions = await EvidenceRepo.listContradictions(caseId);
    const contradictionsBlock = contradictions
      .slice(0, 20)
      .map((c) => `- ${c.factKey}: "${c.leftExcerpt}" vs "${c.rightExcerpt}"`)
      .join("\n");

    const prompt = `You are comparing two lawyers' theories of the same case. Do not merge them or pick a winner — name what they share, what they genuinely disagree on, and for each disagreement the evidence that would decide it and what evidence is still missing.

${theoryBlock("THEORY A", theoryA)}

${theoryBlock("THEORY B", theoryB)}

Known contradictions already found in this case's evidence (use these if they bear on a divergence):
${contradictionsBlock || "(none found yet)"}

Respond with exactly this fenced block and nothing else:
[THEORY_DIFF]
{"sharedClaims": [string], "divergentClaims": [{"claimA": string, "claimB": string, "decidingEvidence": string, "missing": string}]}
[/THEORY_DIFF]`;

    let sessionId = await getChatWonderSessionId();
    let result: { content: string };
    try {
      result = await streamChatWonderMessage(sessionId, prompt, () => {}, undefined, undefined, undefined, tenantCode);
    } catch {
      sessionId = await getChatWonderSessionId();
      result = await streamChatWonderMessage(sessionId, prompt, () => {}, undefined, undefined, undefined, tenantCode);
    }

    const diff = parseTheoryDiff(result.content);
    if (!diff) throw new HttpError("Chat Wonder returned no usable theory diff", 502);

    const row = await TheoryDiffRepo.upsert(caseId, theoryAId, theoryBId, diff);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "theory.diff", payload: { theoryAId, theoryBId } });
    return row;
  }
}
