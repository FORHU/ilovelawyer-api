/** The Citation Map's adverse-citation sweep: which hits are suggested as Weaknesses, Jev's read of
 * a treatment (USE_JEV_ADVERSE_SWEEP), the sweep itself, carrying accept/dismiss decisions across
 * sweeps, and accepting a suggestion. No live Postgres or Jev — repos, services and the TypeSafe
 * client are monkeypatched, same idiom as contradiction-triage.spec.ts. */
import { expect } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import prisma from "../src/lib/prisma";
import CaseAccess from "../src/utils/case-access";
import CaseRepo from "../src/repositories/case.repository";
import CitationCheckRepo from "../src/repositories/citation-check.repository";
import CitationEdgeRepo from "../src/repositories/citation-edge.repository";
import AdverseCitationHitRepo from "../src/repositories/adverse-citation-hit.repository";
import OrganizationRepo from "../src/repositories/organization.repository";
import CaseFindingSvc from "../src/services/case-finding.service";
import AdverseSweepSvc from "../src/services/adverse-sweep.service";
import { checkAdverseCitationWithJev, isSuggestedAsWeakness } from "../src/utils/adverse-citation-jev";

describe("isSuggestedAsWeakness", () => {
  it("always suggests the case's own ADVERSE citation check", () => {
    expect(isSuggestedAsWeakness({ kind: "OWN_STATUS", treatment: null, jev: null })).to.equal(true);
  });

  it("without Jev, suggests overruled and abandoned authorities but not merely distinguished ones", () => {
    expect(isSuggestedAsWeakness({ kind: "NEGATIVE_TREATMENT", treatment: "OVERRULED", jev: null })).to.equal(true);
    expect(isSuggestedAsWeakness({ kind: "NEGATIVE_TREATMENT", treatment: "ABANDONED", jev: null })).to.equal(true);
    expect(isSuggestedAsWeakness({ kind: "NEGATIVE_TREATMENT", treatment: "DISTINGUISHED", jev: null })).to.equal(false);
  });

  it("with Jev, suggests only what Jev reads as defeating the proposition", () => {
    const hit = (effect: "DEFEATS_PROPOSITION" | "DISTINGUISHABLE" | "NOT_ADVERSE", treatment: "OVERRULED" | "DISTINGUISHED") => ({
      kind: "NEGATIVE_TREATMENT" as const,
      treatment,
      jev: { effect, confidence: 0.9 },
    });
    expect(isSuggestedAsWeakness(hit("DEFEATS_PROPOSITION", "DISTINGUISHED"))).to.equal(true);
    expect(isSuggestedAsWeakness(hit("NOT_ADVERSE", "OVERRULED"))).to.equal(false);
  });
});

describe("checkAdverseCitationWithJev", () => {
  const original = TypeSafeClient.prototype.systemOne;
  let reply: unknown;
  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY || "test-key";
    (TypeSafeClient.prototype as any).systemOne = async () => reply;
  });
  afterEach(() => {
    TypeSafeClient.prototype.systemOne = original;
  });
  const input = {
    authority: { reference: "Agabon v. NLRC", citedFor: "Dismissal without notice is ineffectual" },
    treatment: "ABANDONED" as const,
    citingDecision: "Later v. Case",
    excerpt: "we abandon the rule in Agabon",
  };

  it("keeps an unsure NOT_ADVERSE as DISTINGUISHABLE", async () => {
    reply = { answers: { effect: { choice: "NOT_ADVERSE", confidence: 0.6 } } };
    expect(await checkAdverseCitationWithJev(input)).to.deep.equal({ effect: "DISTINGUISHABLE", confidence: 0.6 });
    reply = { answers: { effect: { choice: "NOT_ADVERSE", confidence: 0.8 } } };
    expect((await checkAdverseCitationWithJev(input)).effect).to.equal("NOT_ADVERSE");
  });
});

describe("AdverseSweepSvc", () => {
  const originals = {
    systemOne: TypeSafeClient.prototype.systemOne,
    checkList: CitationCheckRepo.list,
    negativeTreatments: CitationEdgeRepo.listNegativeTreatmentsOf,
    replace: AdverseCitationHitRepo.replace,
    find: AdverseCitationHitRepo.find,
    setDecision: AdverseCitationHitRepo.setDecision,
    markSwept: CaseRepo.markAdverseSwept,
    audit: OrganizationRepo.writeAudit,
    assertCanEdit: CaseAccess.assertCanEdit,
    createFinding: CaseFindingSvc.create,
    flag: process.env.USE_JEV_ADVERSE_SWEEP,
  };
  const check = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    citedReference: id === "cc-agabon" ? "Agabon v. NLRC" : "Art. 297",
    quotedText: "cited for this",
    status: "VALID",
    notes: null,
    resolvedLawId: null,
    ...extra,
  });
  let replaced: any[];
  let lookedUp: string[];

  beforeEach(() => {
    process.env.TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY || "test-key";
    process.env.USE_JEV_ADVERSE_SWEEP = "false";
    replaced = [];
    lookedUp = [];
    (CitationCheckRepo as any).list = async () => [
      check("cc-agabon", { resolvedLawId: "law-agabon" }),
      check("cc-art", { status: "ADVERSE", notes: "Official text contradicts the citation" }),
      { ...check("cc-noref"), citedReference: null },
    ];
    (CitationEdgeRepo as any).listNegativeTreatmentsOf = async (ids: string[]) => {
      lookedUp = ids;
      return [
        { id: "e1", toLawId: "law-agabon", treatment: "ABANDONED", excerpt: "we abandon Agabon", fromLaw: { title: "Later v. Case", caseNumber: "G.R. No. 1" } },
      ];
    };
    (AdverseCitationHitRepo as any).replace = async (_caseId: string, hits: any[]) => {
      replaced = hits;
      return hits.map((h, i) => ({ id: `h${i}`, suggestionStatus: "PENDING", weaknessId: null, jev: null, ...h }));
    };
    (CaseRepo as any).markAdverseSwept = async () => undefined;
    (OrganizationRepo as any).writeAudit = async () => undefined;
    (CaseAccess as any).assertCanEdit = async () => undefined;
  });
  afterEach(() => {
    TypeSafeClient.prototype.systemOne = originals.systemOne;
    (CitationCheckRepo as any).list = originals.checkList;
    (CitationEdgeRepo as any).listNegativeTreatmentsOf = originals.negativeTreatments;
    (AdverseCitationHitRepo as any).replace = originals.replace;
    (AdverseCitationHitRepo as any).find = originals.find;
    (AdverseCitationHitRepo as any).setDecision = originals.setDecision;
    (CaseRepo as any).markAdverseSwept = originals.markSwept;
    (OrganizationRepo as any).writeAudit = originals.audit;
    (CaseAccess as any).assertCanEdit = originals.assertCanEdit;
    (CaseFindingSvc as any).create = originals.createFinding;
    if (originals.flag === undefined) delete process.env.USE_JEV_ADVERSE_SWEEP;
    else process.env.USE_JEV_ADVERSE_SWEEP = originals.flag;
  });

  it("finds the case's own ADVERSE checks and later negative treatments of resolved authorities", async () => {
    const saved = await AdverseSweepSvc.sweep("case-1", "u1");
    expect(lookedUp).to.deep.equal(["law-agabon"]);
    expect(replaced.map((h) => [h.citationCheckId, h.kind, h.treatment, h.citingTitle])).to.deep.equal([
      ["cc-art", "OWN_STATUS", null, null],
      ["cc-agabon", "NEGATIVE_TREATMENT", "ABANDONED", "Later v. Case (G.R. No. 1)"],
    ]);
    expect(saved.every((h) => AdverseSweepSvc.suggested(h))).to.equal(true);
  });

  it("with the flag on, stores Jev's read on treatment hits and keeps a failed one unchecked", async () => {
    process.env.USE_JEV_ADVERSE_SWEEP = "true";
    (TypeSafeClient.prototype as any).systemOne = async () => ({ answers: { effect: { choice: "NOT_ADVERSE", confidence: 0.9 } } });
    await AdverseSweepSvc.sweep("case-1", "u1");
    expect(replaced[1].jev).to.deep.equal({ effect: "NOT_ADVERSE", confidence: 0.9 });

    (TypeSafeClient.prototype as any).systemOne = async () => {
      throw new Error("Jev down");
    };
    await AdverseSweepSvc.sweep("case-1", "u1");
    expect(replaced[1].jev).to.equal(undefined);
  });

  it("accepting a hit creates a MATERIAL weakness and records it on the hit", async () => {
    let created: any;
    let decision: any[] = [];
    (AdverseCitationHitRepo as any).find = async () => ({
      id: "h1",
      citationCheckId: "cc-agabon",
      kind: "NEGATIVE_TREATMENT",
      treatment: "ABANDONED",
      citingTitle: "Later v. Case",
      suggestionStatus: "PENDING",
      weaknessId: null,
    });
    (CaseFindingSvc as any).create = async (_c: string, _u: string, data: any) => {
      created = data;
      return { id: "w1" };
    };
    (AdverseCitationHitRepo as any).setDecision = async (...args: any[]) => {
      decision = args;
      return {};
    };
    await AdverseSweepSvc.accept("case-1", "h1", "u1");
    expect(created).to.deep.equal({
      category: "WEAKNESS",
      tag: "MATERIAL",
      label: "Agabon v. NLRC was abandoned in Later v. Case",
      detail: "Find other authority, or distinguish it",
    });
    expect(decision).to.deep.equal(["h1", "ACCEPTED", "w1"]);
  });
});

describe("AdverseCitationHitRepo.replace", () => {
  const originalTransaction = prisma.$transaction;
  afterEach(() => {
    (prisma as any).$transaction = originalTransaction;
  });

  it("carries a hit's decision and weakness over to the same hit found again", async () => {
    let created: any[] = [];
    const tx = {
      adverseCitationHit: {
        findMany: async () => [
          { citationCheckId: "cc1", edgeId: "e1", suggestionStatus: "ACCEPTED", weaknessId: "w1" },
          { citationCheckId: "cc2", edgeId: null, suggestionStatus: "DISMISSED", weaknessId: null },
        ],
        deleteMany: async () => ({ count: 2 }),
        createMany: async (args: { data: any[] }) => {
          created = args.data;
          return { count: args.data.length };
        },
      },
    };
    (prisma as any).$transaction = async (fn: (t: unknown) => unknown) => fn(tx);
    const originalList = AdverseCitationHitRepo.list;
    (AdverseCitationHitRepo as any).list = async () => [];
    try {
      await AdverseCitationHitRepo.replace("case-1", [
        { citationCheckId: "cc1", kind: "NEGATIVE_TREATMENT", edgeId: "e1", treatment: "OVERRULED", citingTitle: "X", excerpt: null },
        { citationCheckId: "cc2", kind: "OWN_STATUS", edgeId: null, treatment: null, citingTitle: null, excerpt: null },
        { citationCheckId: "cc3", kind: "NEGATIVE_TREATMENT", edgeId: "e3", treatment: "ABANDONED", citingTitle: "Y", excerpt: null },
      ]);
    } finally {
      (AdverseCitationHitRepo as any).list = originalList;
    }
    expect(created.map((h) => [h.citationCheckId, h.suggestionStatus, h.weaknessId])).to.deep.equal([
      ["cc1", "ACCEPTED", "w1"],
      ["cc2", "DISMISSED", null],
      ["cc3", "PENDING", null],
    ]);
  });
});
