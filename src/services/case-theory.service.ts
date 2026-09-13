import { TheoryStance } from "@prisma/client";
import CaseTheoryRepo from "../repositories/case-theory.repository";
import CaseFindingRepo from "../repositories/case-finding.repository";
import CaseAccess from "../utils/case-access";
import CaseGraphSvc from "./case-graph.service";
import CaseEdgeRepo from "../repositories/case-edge.repository";
import OrganizationRepo from "../repositories/organization.repository";
import AiGenerationLockSvc from "./ai-generation-lock.service";
import HttpError from "../utils/http-error";
import { getChatWonderSessionId, streamChatWonderMessage } from "../utils/chatWonder";
import { parseTheoryProposal } from "../utils/theory-parse";

const STANCE_RELATION = { ASSERTS: "SUPPORTS", DENIES: "CONTRADICTS" } as const;

function assertAuthor(theory: { authorUserId: string | null }, userId: string): void {
  // Also blocks editing an AI-proposed theory (authorUserId: null !== any real userId) — a
  // lawyer adopts one by forking it into their own copy instead (CaseTheorySvc.fork), never by
  // editing the AI's draft in place. Same "AI authors; lawyers author" split DecisionRecord and
  // CaseFinding already use.
  if (theory.authorUserId !== userId) {
    throw new HttpError("Only this theory's author can change it — fork it to make your own copy", 403);
  }
}

/**
 * Case Theories (differentiation program, Phase 2 — Workstream B). Several lawyers can hold
 * different theories of the same case side by side; the system never merges them (see
 * TheoryDiffSvc for how divergences are reconciled without picking a winner). See
 * docs/plans/differentiation-program.md.
 */
export default class CaseTheorySvc {
  static async list(caseId: string, userId: string) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    return CaseTheoryRepo.list(caseId);
  }

  static async get(caseId: string, theoryId: string, userId: string) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    const theory = await CaseTheoryRepo.findById(theoryId, caseId);
    if (!theory) throw new HttpError("Theory not found", 404);
    return theory;
  }

  static async create(caseId: string, userId: string, data: { title: string; thesis: string }) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const theory = await CaseTheoryRepo.create(caseId, { authorUserId: userId, title: data.title, thesis: data.thesis });
    await CaseGraphSvc.ensureNode(caseId, "THEORY", theory.id);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "theory.create", payload: { id: theory.id } });
    return theory;
  }

  static async update(caseId: string, theoryId: string, userId: string, data: { title?: string; thesis?: string }) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const theory = await CaseTheoryRepo.findById(theoryId, caseId);
    if (!theory) throw new HttpError("Theory not found", 404);
    assertAuthor(theory, userId);
    const row = await CaseTheoryRepo.update(theoryId, caseId, data);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "theory.update", payload: { id: theoryId } });
    return row;
  }

  /** DRAFT -> ACTIVE. Per the plan's Open Decisions recommendation, an AI-proposed theory stays
   * DRAFT (visible, but plainly unadopted) until a lawyer forks and publishes their own copy. */
  static async publish(caseId: string, theoryId: string, userId: string) {
    return CaseTheorySvc.setStatus(caseId, theoryId, userId, "ACTIVE", "theory.publish");
  }

  static async retire(caseId: string, theoryId: string, userId: string) {
    return CaseTheorySvc.setStatus(caseId, theoryId, userId, "RETIRED", "theory.retire");
  }

  private static async setStatus(
    caseId: string,
    theoryId: string,
    userId: string,
    status: "ACTIVE" | "RETIRED",
    action: string,
  ) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const theory = await CaseTheoryRepo.findById(theoryId, caseId);
    if (!theory) throw new HttpError("Theory not found", 404);
    assertAuthor(theory, userId);
    const row = await CaseTheoryRepo.update(theoryId, caseId, { status });
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action, payload: { id: theoryId } });
    return row;
  }

  /** Copies title/thesis/claims/assumptions/openQuestions into a brand-new DRAFT theory owned
   * by `userId`, with `forkedFromId` pointing at the source — the only way to turn an
   * AI-proposed theory (or another lawyer's) into something you can edit and publish. */
  static async fork(caseId: string, theoryId: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const source = await CaseTheoryRepo.findById(theoryId, caseId);
    if (!source) throw new HttpError("Theory not found", 404);

    const forked = await CaseTheoryRepo.create(caseId, {
      authorUserId: userId,
      title: source.title,
      thesis: source.thesis,
      forkedFromId: source.id,
    });
    await CaseGraphSvc.ensureNode(caseId, "THEORY", forked.id);
    for (const claim of source.claims) {
      await CaseTheoryRepo.addClaim(forked.id, { statement: claim.statement, stance: claim.stance, graphNodeId: claim.graphNodeId });
    }
    for (const assumption of source.assumptions) {
      await CaseTheoryRepo.addAssumption(forked.id, assumption.statement);
    }
    for (const openQuestion of source.openQuestions) {
      await CaseTheoryRepo.addOpenQuestion(forked.id, openQuestion.question);
    }
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "theory.fork", payload: { id: forked.id, forkedFromId: source.id } });
    return CaseTheoryRepo.findById(forked.id, caseId);
  }

  /** `graphNodeId` optionally links this claim to an existing CaseGraphNode (a CLAIM, FINDING
   * or DOCUMENT, typically) — when given, mirrors it as a CaseEdge from the theory's own
   * THEORY node so the claim shows up in the Mind Map/citation-map with no dedicated UI. */
  static async addClaim(
    caseId: string,
    theoryId: string,
    userId: string,
    data: { statement: string; stance: TheoryStance; graphNodeId?: string },
  ) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const theory = await CaseTheoryRepo.findById(theoryId, caseId);
    if (!theory) throw new HttpError("Theory not found", 404);
    assertAuthor(theory, userId);
    const claim = await CaseTheoryRepo.addClaim(theoryId, {
      statement: data.statement,
      stance: data.stance,
      graphNodeId: data.graphNodeId ?? null,
    });
    if (data.graphNodeId) {
      const theoryNode = await CaseGraphSvc.ensureNode(caseId, "THEORY", theoryId);
      await CaseEdgeRepo.create(caseId, {
        sourceEntityId: theoryNode.id,
        targetEntityId: data.graphNodeId,
        relationType: STANCE_RELATION[data.stance],
        metadata: { theoryClaimId: claim.id, statement: data.statement },
      }).catch(() => {});
    }
    return claim;
  }

  static async addAssumption(caseId: string, theoryId: string, userId: string, statement: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const theory = await CaseTheoryRepo.findById(theoryId, caseId);
    if (!theory) throw new HttpError("Theory not found", 404);
    assertAuthor(theory, userId);
    return CaseTheoryRepo.addAssumption(theoryId, statement);
  }

  static async addOpenQuestion(caseId: string, theoryId: string, userId: string, question: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const theory = await CaseTheoryRepo.findById(theoryId, caseId);
    if (!theory) throw new HttpError("Theory not found", 404);
    assertAuthor(theory, userId);
    return CaseTheoryRepo.addOpenQuestion(theoryId, question);
  }

  /** Fast, synchronous half of a queued propose — access check + claiming the AiGenerationJob
   * row — mirrors CaseReconstructionSvc.beginQueued/runQueued. */
  static async beginQueuedPropose(caseId: string, userId: string): Promise<void> {
    await CaseAccess.assertCanEdit(caseId, userId);
    await AiGenerationLockSvc.begin(caseId, "caseTheoryPropose");
  }

  static async runQueuedPropose(caseId: string, userId: string): Promise<void> {
    await AiGenerationLockSvc.finishWith(caseId, "caseTheoryPropose", () => CaseTheorySvc.proposeInner(caseId, userId));
  }

  /**
   * Seeds a DRAFT theory (authorUserId: null — AI-authored, see the plan's Open Decisions:
   * "private DRAFT until published") from the case's own findings/strategy — not from raw
   * documents, so this is a synthesis of work already done, not a fresh investigation.
   */
  private static async proposeInner(caseId: string, userId: string) {
    const tenantCode = await CaseAccess.resolveTenantCode(caseId);
    const findings = await CaseFindingRepo.list(caseId);
    if (findings.length === 0) {
      throw new HttpError("No findings yet to propose a theory from — run Refresh analysis first", 422);
    }

    const byCategory = new Map<string, string[]>();
    for (const f of findings) {
      const list = byCategory.get(f.category) ?? [];
      list.push(f.label);
      byCategory.set(f.category, list);
    }
    const findingsBlock = [...byCategory.entries()]
      .map(([category, labels]) => `${category}:\n${labels.map((l) => `- ${l}`).join("\n")}`)
      .join("\n\n");

    const prompt = `You are helping a litigation team consider one coherent theory of this case, built strictly from the findings below — every finding already came from this case's own documents, so use them as given rather than re-deriving anything new.

[FINDINGS]
${findingsBlock}
[/FINDINGS]

Draft ONE theory of the case: a short title, a 2-4 sentence thesis, the claims it asserts or denies (each grounded in one of the findings above), the assumptions it rests on, and the open questions that would need answering to firm it up.

Respond with exactly this fenced block and nothing else:
[THEORY_PROPOSAL]
{"title": string, "thesis": string, "claims": [{"statement": string, "stance": "ASSERTS"|"DENIES"}], "assumptions": [string], "openQuestions": [string]}
[/THEORY_PROPOSAL]`;

    let sessionId = await getChatWonderSessionId();
    let result: { content: string };
    try {
      result = await streamChatWonderMessage(sessionId, prompt, () => {}, undefined, undefined, undefined, tenantCode);
    } catch {
      sessionId = await getChatWonderSessionId();
      result = await streamChatWonderMessage(sessionId, prompt, () => {}, undefined, undefined, undefined, tenantCode);
    }

    const proposal = parseTheoryProposal(result.content);
    if (!proposal) throw new HttpError("Chat Wonder returned no usable theory proposal", 502);

    const theory = await CaseTheoryRepo.create(caseId, { authorUserId: null, title: proposal.title, thesis: proposal.thesis });
    await CaseGraphSvc.ensureNode(caseId, "THEORY", theory.id);
    for (const claim of proposal.claims) {
      await CaseTheoryRepo.addClaim(theory.id, { statement: claim.statement, stance: claim.stance });
    }
    for (const assumption of proposal.assumptions) {
      await CaseTheoryRepo.addAssumption(theory.id, assumption);
    }
    for (const openQuestion of proposal.openQuestions) {
      await CaseTheoryRepo.addOpenQuestion(theory.id, openQuestion);
    }
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "theory.propose", payload: { id: theory.id } });
    return CaseTheoryRepo.findById(theory.id, caseId);
  }
}
