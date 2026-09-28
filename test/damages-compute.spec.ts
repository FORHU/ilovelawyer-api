import { expect } from "chai";
import { describe, it } from "mocha";
import {
  computeDamagesSummary,
  DamageHeadInput,
  formatDamageForPrompt,
  hasBasisInputs,
  monthsBetween,
  niceCeiling,
  parseDamageBasis,
} from "../src/utils/damages-compute";

function head(overrides: Partial<DamageHeadInput> & Pick<DamageHeadInput, "id" | "category">): DamageHeadInput {
  return {
    amount: null,
    basis: null,
    amountLow: null,
    amountHigh: null,
    status: "PROVISIONAL",
    pendingEvidence: null,
    ...overrides,
  };
}

// The Damages & Remedies mockup: an illegal-dismissal case with five heads.
const MOCKUP: DamageHeadInput[] = [
  head({
    id: "actual",
    category: "ACTUAL",
    basis: { kind: "RATE_X_PERIOD", monthlyRate: 27000, months: 18 },
    pendingEvidence: "payroll certification",
  }),
  head({ id: "moral", category: "MORAL", amount: 200000 }),
  head({ id: "exemplary", category: "EXEMPLARY", amount: 100000 }),
  head({
    id: "fees",
    category: "ATTORNEYS_FEES",
    basis: { kind: "PERCENT_OF", percent: 10, categories: ["ACTUAL", "MORAL", "EXEMPLARY"] },
  }),
  head({ id: "other", category: "OTHER", amount: 54000, pendingEvidence: "payroll certification" }),
];

describe("computeDamagesSummary", () => {
  it("reproduces the mockup's figures", () => {
    const s = computeDamagesSummary(MOCKUP, "PH");
    const byId = Object.fromEntries(s.heads.map((h) => [h.id, h]));

    expect(byId.actual!.amount).to.equal(486000);
    expect(byId.fees!.amount).to.equal(78600);
    expect(byId.fees!.derived).to.equal(true);
    expect(s.total).to.equal(918600);
    expect(s.headCount).to.equal(5);
    expect(s.currency).to.equal("PHP");
    expect(s.heads.map((h) => Math.round(h.share * 100))).to.deep.equal([53, 22, 11, 9, 6]);
    expect(s.provisional).to.equal(true);
    expect(s.pendingEvidence).to.deep.equal(["payroll certification"]);
  });

  it("sums per-head ranges, deriving the fee range from its base heads", () => {
    const heads = MOCKUP.map((h) =>
      h.id === "moral" ? { ...h, amountLow: 0, amountHigh: 300000 } : h.id === "exemplary" ? { ...h, amountLow: 0 } : h,
    );
    const s = computeDamagesSummary(heads, "PH");
    const fees = s.heads.find((h) => h.id === "fees")!;

    expect(fees.low).to.equal(48600); // 10% of 486,000
    expect(fees.high).to.equal(88600); // 10% of 486,000 + 300,000 + 100,000
    expect(s.low).to.equal(486000 + 0 + 0 + 48600 + 54000);
    expect(s.high).to.equal(486000 + 300000 + 100000 + 88600 + 54000);
    expect(s.scaleMax).to.equal(1200000);
  });

  it("uses an explicit range on a derived head over the computed one", () => {
    const heads = MOCKUP.map((h) => (h.id === "fees" ? { ...h, amountLow: 10000, amountHigh: 90000 } : h));
    const fees = computeDamagesSummary(heads).heads.find((h) => h.id === "fees")!;
    expect([fees.low, fees.high]).to.deep.equal([10000, 90000]);
  });

  it("makes a derived head only as firm as its weakest base head", () => {
    const certified = MOCKUP.map((h) => ({ ...h, status: "CERTIFIED" as const }));
    expect(computeDamagesSummary(certified).provisional).to.equal(false);

    const oneProvisional = certified.map((h) => (h.id === "moral" ? { ...h, status: "PROVISIONAL" as const } : h));
    const s = computeDamagesSummary(oneProvisional);
    expect(s.heads.find((h) => h.id === "fees")!.effectiveStatus).to.equal("PROVISIONAL");
    expect(s.heads.find((h) => h.id === "other")!.effectiveStatus).to.equal("CERTIFIED");
    // Moral has no pendingEvidence, and certified heads' evidence isn't pending any more.
    expect(s.pendingEvidence).to.deep.equal([]);
  });

  it("never lets derived heads feed each other", () => {
    const heads = [
      head({ id: "a", category: "ACTUAL", amount: 1000 }),
      head({ id: "f1", category: "ATTORNEYS_FEES", basis: { kind: "PERCENT_OF", percent: 10, categories: ["ACTUAL", "OTHER"] } }),
      head({ id: "f2", category: "OTHER", basis: { kind: "PERCENT_OF", percent: 50, categories: ["ATTORNEYS_FEES"] } }),
    ];
    const s = computeDamagesSummary(heads);
    expect(s.heads.find((h) => h.id === "f1")!.amount).to.equal(100);
    expect(s.heads.find((h) => h.id === "f2")!.amount).to.equal(0);
  });

  it("handles an empty case and heads with no amount", () => {
    const empty = computeDamagesSummary([], "UK");
    expect(empty).to.include({ total: 0, low: 0, high: 0, scaleMax: 0, headCount: 0, provisional: false, currency: "GBP" });

    const s = computeDamagesSummary([
      head({ id: "a", category: "ACTUAL" }),
      head({ id: "b", category: "ACTUAL", basis: { kind: "RATE_X_PERIOD", monthlyRate: 1000 } }),
    ]);
    expect(s.heads.map((h) => h.amount)).to.deep.equal([null, null]);
    expect(s.heads.map((h) => h.share)).to.deep.equal([0, 0]);
    expect(s.total).to.equal(0);
  });

  it("computes the period from dates", () => {
    const s = computeDamagesSummary([
      head({
        id: "a",
        category: "ACTUAL",
        basis: { kind: "RATE_X_PERIOD", monthlyRate: 30000, fromDate: "2025-01-15", untilDate: "2025-07-30" },
      }),
    ]);
    expect(s.heads[0]!.amount).to.equal(30000 * 6.5);
  });
});

describe("damages-compute helpers", () => {
  it("monthsBetween counts calendar months plus leftover days over 30", () => {
    expect(monthsBetween("2025-01-15", "2026-07-15")).to.equal(18);
    expect(monthsBetween("2025-01-31", "2025-03-01")).to.equal(1.03);
    expect(monthsBetween("2025-03-01", "2025-01-01")).to.equal(undefined);
    expect(monthsBetween("nope", "2025-01-01")).to.equal(undefined);
  });

  it("niceCeiling rounds up to a fifth of the order of magnitude", () => {
    expect(niceCeiling(1240000)).to.equal(1400000);
    expect(niceCeiling(918600)).to.equal(920000);
    expect(niceCeiling(47000)).to.equal(48000);
    expect(niceCeiling(1000000)).to.equal(1000000);
    expect(niceCeiling(0)).to.equal(0);
  });

  it("parseDamageBasis reads anything malformed as FIXED", () => {
    expect(parseDamageBasis(null)).to.deep.equal({ kind: "FIXED" });
    expect(parseDamageBasis({ kind: "RATE_X_PERIOD" })).to.deep.equal({ kind: "FIXED" });
    expect(parseDamageBasis({ kind: "PERCENT_OF", percent: 10, categories: ["NOPE"] })).to.deep.equal({ kind: "FIXED" });
  });

  it("hasBasisInputs requires an amount or a period", () => {
    expect(hasBasisInputs({ amount: null, basis: null })).to.equal(false);
    expect(hasBasisInputs({ amount: 5, basis: null })).to.equal(true);
    expect(hasBasisInputs({ amount: null, basis: { kind: "RATE_X_PERIOD", monthlyRate: 1 } })).to.equal(false);
    expect(hasBasisInputs({ amount: null, basis: { kind: "RATE_X_PERIOD", monthlyRate: 1, months: 2 } })).to.equal(true);
  });

  it("formatDamageForPrompt keeps the description verbatim and adds the model's details", () => {
    expect(formatDamageForPrompt({ category: "MORAL", amount: 200000, description: "Humiliating dismissal" })).to.equal(
      "MORAL: 200000 — Humiliating dismissal",
    );
    expect(
      formatDamageForPrompt({
        category: "ACTUAL",
        label: "Actual (backwages)",
        amount: 486000,
        status: "PROVISIONAL",
        low: 430000,
        high: 560000,
        basisText: "27000 × 18 months",
        pendingEvidence: "payroll certification",
      }),
    ).to.equal(
      "ACTUAL (Actual (backwages)): 486000 [provisional; range 430000–560000; basis 27000 × 18 months; pending payroll certification]",
    );
  });
});
