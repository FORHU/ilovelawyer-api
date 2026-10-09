import ManualEditLog from "./manual-edit-log.service";
import { fieldChanges } from "../utils/manual-edit-changes";
import CaseChangeRun from "./case-change-run.service";
import CaseChangeReads from "./case-change-reads";
import { diffTheory } from "../utils/case-change-delta";
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
import { newTraceRun } from "./trace-collector.service";
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
    await ManualEditLog.record(caseId, userId, { pane: "theories", kind: "theory", itemId: theory.id, action: "added", label: theory.title });
    return theory;
  }

  static async update(caseId: string, theoryId: string, userId: string, data: { title?: string; thesis?: string }) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const theory = await CaseTheoryRepo.findById(theoryId, caseId);
    if (!theory) throw new HttpError("Theory not found", 404);
    assertAuthor(theory, userId);
    const row = await CaseTheoryRepo.update(theoryId, caseId, data);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "theory.update", payload: { id: theoryId } });
    await ManualEditLog.record(caseId, userId, {
      pane: "theories",
      kind: "theory",
      itemId: theoryId,
      action: "edited",
      label: data.title ?? theory.title,
      changes: fieldChanges(theory, data, { title: "value", thesis: "text" }),
    });
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
    await ManualEditLog.record(caseId, userId, {
      pane: "theories",
      kind: "theory",
      itemId: theoryId,
      action: status === "ACTIVE" ? "published" : "retired",
      label: theory.title,
    });
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
    await ManualEditLog.record(caseId, userId, { pane: "theories", kind: "theory", itemId: forked.id, action: "forked", label: source.title });
    return CaseTheoryRepo.findById(forked.id, caseId);
  }

  /** The author can delete any theory they wrote (original or fork). An AI-proposed theory
   * (authorUserId: null) has no author, so anyone who can edit the case may dismiss it. Another
   * lawyer's theory stays protected — that's theirs to retire or delete. Forks of a deleted
   * theory survive; forkedFromId has no FK, so they just lose their parent link in the UI. */
  static async remove(caseId: string, theoryId: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const theory = await CaseTheoryRepo.findById(theoryId, caseId);
    if (!theory) throw new HttpError("Theory not found", 404);
    if (theory.authorUserId !== null && theory.authorUserId !== userId) {
      throw new HttpError("Only this theory's author can delete it", 403);
    }
    const deleted = await CaseTheoryRepo.deleteWithDependents(theoryId, caseId);
    if (!deleted) throw new HttpError("Theory not found", 404);
    // Its THEORY graph node, and with it (FK cascade) the edges its graph-linked claims made.
    await CaseGraphSvc.removeNode("THEORY", theoryId);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "theory.delete", payload: { id: theoryId, forkedFromId: theory.forkedFromId } });
    await ManualEditLog.record(caseId, userId, { pane: "theories", kind: "theory", itemId: theoryId, action: "removed", label: theory.title });
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
    await ManualEditLog.record(caseId, userId, { pane: "theories", kind: "theoryClaim", itemId: claim.id, action: "added", label: claim.statement });
    return claim;
  }

  /** Edits a claim's text and/or stance. A graph-linked claim's mirrored CaseEdge (see addClaim)
   * is rebuilt so the Mind Map shows the new stance/statement rather than the old one. */
  static async updateClaim(
    caseId: string,
    theoryId: string,
    claimId: string,
    userId: string,
    data: { statement?: string; stance?: TheoryStance },
  ) {
    const theory = await CaseTheorySvc.loadOwnTheory(caseId, theoryId, userId);
    const before = theory.claims.find((c) => c.id === claimId);
    const claim = await CaseTheoryRepo.updateClaim(claimId, theoryId, data);
    if (!claim) throw new HttpError("Claim not found", 404);
    await ManualEditLog.record(caseId, userId, {
      pane: "theories",
      kind: "theoryClaim",
      itemId: claimId,
      action: "edited",
      label: claim.statement,
      changes: fieldChanges(before, data, { statement: "text", stance: "value" }),
    });
    if (claim.graphNodeId) {
      await CaseEdgeRepo.deleteByTheoryClaim(caseId, claim.id);
      const theoryNode = await CaseGraphSvc.ensureNode(caseId, "THEORY", theoryId);
      await CaseEdgeRepo.create(caseId, {
        sourceEntityId: theoryNode.id,
        targetEntityId: claim.graphNodeId,
        relationType: STANCE_RELATION[claim.stance],
        metadata: { theoryClaimId: claim.id, statement: claim.statement },
      }).catch(() => {});
    }
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "theory.claim.update", payload: { id: theoryId, claimId } });
    return claim;
  }

  static async deleteClaim(caseId: string, theoryId: string, claimId: string, userId: string) {
    const theory = await CaseTheorySvc.loadOwnTheory(caseId, theoryId, userId);
    const before = theory.claims.find((c) => c.id === claimId);
    const deleted = await CaseTheoryRepo.deleteClaim(claimId, theoryId);
    if (!deleted) throw new HttpError("Claim not found", 404);
    if (before) await ManualEditLog.record(caseId, userId, { pane: "theories", kind: "theoryClaim", itemId: claimId, action: "removed", label: before.statement });
    await CaseEdgeRepo.deleteByTheoryClaim(caseId, claimId);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "theory.claim.delete", payload: { id: theoryId, claimId } });
  }

  static async updateAssumption(caseId: string, theoryId: string, assumptionId: string, userId: string, statement: string) {
    const theory = await CaseTheorySvc.loadOwnTheory(caseId, theoryId, userId);
    const before = theory.assumptions.find((a) => a.id === assumptionId);
    const row = await CaseTheoryRepo.updateAssumption(assumptionId, theoryId, statement);
    if (!row) throw new HttpError("Assumption not found", 404);
    await ManualEditLog.record(caseId, userId, {
      pane: "theories",
      kind: "theoryAssumption",
      itemId: assumptionId,
      action: "edited",
      label: row.statement,
      changes: fieldChanges(before, { statement }, { statement: "text" }),
    });
    return row;
  }

  static async deleteAssumption(caseId: string, theoryId: string, assumptionId: string, userId: string) {
    const theory = await CaseTheorySvc.loadOwnTheory(caseId, theoryId, userId);
    const before = theory.assumptions.find((a) => a.id === assumptionId);
    if (!(await CaseTheoryRepo.deleteAssumption(assumptionId, theoryId))) throw new HttpError("Assumption not found", 404);
    if (before) {
      await ManualEditLog.record(caseId, userId, { pane: "theories", kind: "theoryAssumption", itemId: assumptionId, action: "removed", label: before.statement });
    }
  }

  static async updateOpenQuestion(caseId: string, theoryId: string, questionId: string, userId: string, question: string) {
    const theory = await CaseTheorySvc.loadOwnTheory(caseId, theoryId, userId);
    const before = theory.openQuestions.find((q) => q.id === questionId);
    const row = await CaseTheoryRepo.updateOpenQuestion(questionId, theoryId, question);
    if (!row) throw new HttpError("Open question not found", 404);
    await ManualEditLog.record(caseId, userId, {
      pane: "theories",
      kind: "theoryQuestion",
      itemId: questionId,
      action: "edited",
      label: row.question,
      changes: fieldChanges(before, { question }, { question: "text" }),
    });
    return row;
  }

  static async deleteOpenQuestion(caseId: string, theoryId: string, questionId: string, userId: string) {
    const theory = await CaseTheorySvc.loadOwnTheory(caseId, theoryId, userId);
    const before = theory.openQuestions.find((q) => q.id === questionId);
    if (!(await CaseTheoryRepo.deleteOpenQuestion(questionId, theoryId))) throw new HttpError("Open question not found", 404);
    if (before) {
      await ManualEditLog.record(caseId, userId, { pane: "theories", kind: "theoryQuestion", itemId: questionId, action: "removed", label: before.question });
    }
  }

  /** Same gate every theory edit goes through: can edit the case, theory exists, caller wrote it. */
  private static async loadOwnTheory(caseId: string, theoryId: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const theory = await CaseTheoryRepo.findById(theoryId, caseId);
    if (!theory) throw new HttpError("Theory not found", 404);
    assertAuthor(theory, userId);
    return theory;
  }

  static async addAssumption(caseId: string, theoryId: string, userId: string, statement: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const theory = await CaseTheoryRepo.findById(theoryId, caseId);
    if (!theory) throw new HttpError("Theory not found", 404);
    assertAuthor(theory, userId);
    const row = await CaseTheoryRepo.addAssumption(theoryId, statement);
    await ManualEditLog.record(caseId, userId, { pane: "theories", kind: "theoryAssumption", itemId: row.id, action: "added", label: row.statement });
    return row;
  }

  static async addOpenQuestion(caseId: string, theoryId: string, userId: string, question: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const theory = await CaseTheoryRepo.findById(theoryId, caseId);
    if (!theory) throw new HttpError("Theory not found", 404);
    assertAuthor(theory, userId);
    const row = await CaseTheoryRepo.addOpenQuestion(theoryId, question);
    await ManualEditLog.record(caseId, userId, { pane: "theories", kind: "theoryQuestion", itemId: row.id, action: "added", label: row.question });
    return row;
  }

  /** Fast, synchronous half of a queued propose — access check + claiming the AiGenerationJob
   * row — mirrors CaseReconstructionSvc.beginQueued/runQueued. */
  static async beginQueuedPropose(caseId: string, userId: string): Promise<void> {
    await CaseAccess.assertCanEdit(caseId, userId);
    await AiGenerationLockSvc.assertAnalysisIdle(caseId);
    await AiGenerationLockSvc.begin(caseId, "caseTheoryPropose");
  }

  static async runQueuedPropose(caseId: string, userId: string): Promise<void> {
    // The "What changed" modal then describes this run (CaseChangeRun).
    await AiGenerationLockSvc.finishWith(caseId, "caseTheoryPropose", () =>
      CaseChangeRun.regenerate(
        caseId,
        userId,
        "theory",
        () => CaseChangeReads.theory(caseId),
        () => CaseTheorySvc.proposeInner(caseId, userId),
        (before, after) => diffTheory(before, after),
      ),
    );
  }

  /** The analysis refresh's Theories step (CaseRefreshSvc), holding the same
   * "caseTheoryPropose" lock as the lawyer's Regenerate. A case with no findings yet is skipped
   * quietly — the 422 proposeInner throws is for a button click, not a background step. */
  static async refreshAiDraft(caseId: string, userId: string): Promise<{ skipped: boolean }> {
    if ((await CaseFindingRepo.list(caseId)).length === 0) return { skipped: true };
    await AiGenerationLockSvc.run(caseId, "caseTheoryPropose", () => CaseTheorySvc.proposeInner(caseId, userId));
    return { skipped: false };
  }

  /**
   * Writes the case's one AI draft theory (authorUserId: null — AI-authored, see the plan's Open
   * Decisions: "private DRAFT until published") from the case's own findings/strategy — not from
   * raw documents, so this is a synthesis of work already done, not a fresh investigation.
   *
   * One draft per case, updated in place: the newest AI theory is rewritten (same id, so forks'
   * forkedFromId and an open diff still point at it), and only created when none exists. Lawyer
   * theories and forks are never touched. Older AI drafts from before this rule are left alone.
   */
  private static async proposeInner(caseId: string, userId: string) {
    const tenantCode = await CaseAccess.resolveTenantCode(caseId);
    const findings = await CaseFindingRepo.list(caseId);
    if (findings.length === 0) {
      throw new HttpError("No findings yet to propose a theory from — add documents so the analysis can run first", 422);
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

    // One trace run for both attempts: a retry on a fresh session adds to the same entry in the AI Reasoning pane.
    const trace = newTraceRun("caseTheory", caseId, userId);
    let sessionId = await getChatWonderSessionId();
    let result: { content: string };
    try {
      result = await streamChatWonderMessage(sessionId, prompt, () => {}, undefined, undefined, undefined, tenantCode, undefined, undefined, undefined, { skipLegalVerify: true, trace });
    } catch {
      sessionId = await getChatWonderSessionId();
      result = await streamChatWonderMessage(sessionId, prompt, () => {}, undefined, undefined, undefined, tenantCode, undefined, undefined, undefined, { skipLegalVerify: true, trace });
    }

    const proposal = parseTheoryProposal(result.content);
    if (!proposal) throw new HttpError("Chat Wonder returned no usable theory proposal", 502);

    const existing = await CaseTheoryRepo.findLatestAiDraft(caseId);
    const theory = existing
      ? await CaseTheoryRepo.replaceAiDraft(existing.id, caseId, proposal)
      : await CaseTheoryRepo.create(caseId, { authorUserId: null, title: proposal.title, thesis: proposal.thesis });
    if (!theory) throw new HttpError("Theory not found", 404);
    await CaseGraphSvc.ensureNode(caseId, "THEORY", theory.id);
    if (!existing) {
      for (const claim of proposal.claims) {
        await CaseTheoryRepo.addClaim(theory.id, { statement: claim.statement, stance: claim.stance });
      }
      for (const assumption of proposal.assumptions) {
        await CaseTheoryRepo.addAssumption(theory.id, assumption);
      }
      for (const openQuestion of proposal.openQuestions) {
        await CaseTheoryRepo.addOpenQuestion(theory.id, openQuestion);
      }
    }
    await OrganizationRepo.writeAudit({
      caseId,
      actorId: userId,
      action: "theory.propose",
      payload: { id: theory.id, replaced: !!existing },
    });
    return CaseTheoryRepo.findById(theory.id, caseId);
  }
}
