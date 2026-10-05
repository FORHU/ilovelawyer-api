import { expect } from "chai";
import { describe, it } from "mocha";
import { computeDamagesSummary, currencyForTenant, formatDamageForPrompt, type DamageEntryInput } from "../src/utils/damages-compute";

const entry = (extra: Partial<DamageEntryInput> = {}): DamageEntryInput => ({
  kind: "DAMAGE",
  amount: null,
  done: false,
  accepted: true,
  ...extra,
});

describe("computeDamagesSummary", () => {
  it("adds up accepted amounts, and the part already awarded or received", () => {
    const summary = computeDamagesSummary(
      [
        entry({ amount: 486000.5 }),
        entry({ amount: 200000, done: true }),
        entry({ kind: "REMEDY", amount: null }),
      ],
      "PH",
    );
    expect(summary).to.deep.equal({
      currency: "PHP",
      total: 686000.5,
      awarded: 200000,
      headCount: 3,
      damageCount: 2,
      remedyCount: 1,
      doneCount: 1,
      suggestedCount: 0,
      suggestedTotal: 0,
    });
  });

  it("leaves AI proposals no lawyer has accepted out of everything", () => {
    const summary = computeDamagesSummary([entry({ amount: 1000 }), entry({ amount: 999999, accepted: false })], "UK");
    expect(summary).to.include({ currency: "GBP", total: 1000, headCount: 1 });
  });

  it("counts the AI suggestions waiting, and what they would add, beside the total", () => {
    const summary = computeDamagesSummary(
      [entry({ amount: 1000 }), entry({ amount: 5400, accepted: false }), entry({ kind: "REMEDY", accepted: false })],
      "UK",
    );
    expect(summary).to.include({ total: 1000, headCount: 1, suggestedCount: 2, suggestedTotal: 5400 });
  });

  it("is all zeroes for a case with no entries", () => {
    expect(computeDamagesSummary([])).to.include({ total: 0, awarded: 0, headCount: 0 });
  });
});

describe("currencyForTenant", () => {
  it("is GBP for UK and PHP otherwise", () => {
    expect(currencyForTenant("UK")).to.equal("GBP");
    expect(currencyForTenant("PH")).to.equal("PHP");
    expect(currencyForTenant(null)).to.equal("PHP");
  });
});

describe("formatDamageForPrompt", () => {
  it("writes kind, title, amount, description, whether it is awarded, and the due date", () => {
    expect(
      formatDamageForPrompt({
        kind: "DAMAGE",
        title: "Backwages",
        description: "unpaid wages since dismissal",
        amount: 486000,
        done: false,
        dueDate: "2026-11-15T00:00:00.000Z",
      }),
    ).to.equal("DAMAGE (Backwages): 486000 — unpaid wages since dismissal [not yet awarded; due 2026-11-15]");
  });

  it("leaves out what an entry doesn't have", () => {
    expect(formatDamageForPrompt({ kind: "REMEDY", title: "Reinstatement", done: true })).to.equal(
      "REMEDY (Reinstatement) [awarded or received]",
    );
  });
});
