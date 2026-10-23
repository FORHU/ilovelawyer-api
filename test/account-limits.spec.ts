import { expect } from "chai";
import { describe, it } from "mocha";
import AccountLimitsSvc from "../src/services/account-limits.service";
import { startsAiWork } from "../src/middleware/account-spend-limit.middleware";

/** A stand-in for the database: one user with a role, a number of cases, an extra (top-up) AI
 * allowance and a recorded AI spend. `tenantId: null` (the default here) keeps allowanceInfo on the
 * CASE_SPEND_LIMIT_USD fallback path, skipping the live, DB-backed subscription-plan lookup — that
 * lookup is AccountTopUpPricingSvc's own concern. */
const db = (opts: { role?: string; cases?: number; spend?: number | null; extra?: number }) =>
  ({
    user: {
      findUnique: async () => (opts.role ? { role: opts.role, extraAiAllowanceUsd: opts.extra ?? 0, tenantId: null } : null),
      update: async (args: { data: { extraAiAllowanceUsd: { increment: number } } }) => ({ id: "u", email: "u@example.com", extraAiAllowanceUsd: args.data.extraAiAllowanceUsd.increment }),
    },
    case: { count: async () => opts.cases ?? 0 },
    llmUsage: { aggregate: async () => ({ _sum: { estimatedCostUsd: opts.spend ?? null } }) },
  }) as never;

const rejection = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (err) {
    return err as Error & { statusCode: number; code?: string; details?: unknown };
  }
  return null;
};

describe("cases a lawyer may own", () => {
  it("lets a lawyer create a case while under the limit", async () => {
    expect(await rejection(() => AccountLimitsSvc.assertCanCreateCase("u", db({ role: "LAWYER", cases: 2 }), 3))).to.equal(null);
  });

  it("stops a lawyer who already owns the limit, with a reason a client can branch on", async () => {
    const err = await rejection(() => AccountLimitsSvc.assertCanCreateCase("u", db({ role: "LAWYER", cases: 3 }), 3));
    expect(err?.statusCode).to.equal(403);
    expect(err?.code).to.equal("CASE_LIMIT_REACHED");
  });

  it("keeps a lawyer who is already over the limit out of creating more, without touching their cases", async () => {
    const err = await rejection(() => AccountLimitsSvc.assertCanCreateCase("u", db({ role: "LAWYER", cases: 7 }), 3));
    expect(err?.code).to.equal("CASE_LIMIT_REACHED");
  });

  it("never limits staff or other roles", async () => {
    for (const role of ["ADMIN", "USER"]) {
      expect(await rejection(() => AccountLimitsSvc.assertCanCreateCase("u", db({ role, cases: 50 }), 3))).to.equal(null);
    }
  });

  it("is off by default (0)", async () => {
    expect(await rejection(() => AccountLimitsSvc.assertCanCreateCase("u", db({ role: "LAWYER", cases: 50 })))).to.equal(null);
  });
});

describe("an account's AI allowance", () => {
  it("lets a lawyer's account work while under the allowance", async () => {
    expect(await rejection(() => AccountLimitsSvc.assertAccountHasBudget("u", db({ role: "LAWYER", spend: 19.99 })))).to.equal(null);
    expect(await rejection(() => AccountLimitsSvc.assertAccountHasBudget("u", db({ role: "LAWYER", spend: null })))).to.equal(null);
  });

  it("stops new AI work at the allowance", async () => {
    const err = await rejection(() => AccountLimitsSvc.assertAccountHasBudget("u", db({ role: "LAWYER", spend: 20 })));
    expect(err?.statusCode).to.equal(403);
    expect(err?.code).to.equal("ACCOUNT_ALLOWANCE_REACHED");
  });

  it("never states the ceiling as a bare number in the error", async () => {
    const err = await rejection(() => AccountLimitsSvc.assertAccountHasBudget("u", db({ role: "LAWYER", spend: 23.456 })));
    expect(err?.message).to.not.match(/\d|\$|USD|dollar/i);
    expect(err?.details).to.equal(undefined);
  });

  it("tells the lawyer to top up", async () => {
    const err = await rejection(() => AccountLimitsSvc.assertAccountHasBudget("u", db({ role: "LAWYER", spend: 20 })));
    expect(err?.message).to.match(/top up/i);
  });

  it("counts top-up credit on top of the standard allowance", async () => {
    expect(await rejection(() => AccountLimitsSvc.assertAccountHasBudget("u", db({ role: "LAWYER", spend: 25, extra: 20 })))).to.equal(null);
    const err = await rejection(() => AccountLimitsSvc.assertAccountHasBudget("u", db({ role: "LAWYER", spend: 40, extra: 20 })));
    expect(err?.code).to.equal("ACCOUNT_ALLOWANCE_REACHED");
  });

  it("does not limit staff, another role, or a user that doesn't exist", async () => {
    for (const role of ["ADMIN", "USER"]) {
      expect(await rejection(() => AccountLimitsSvc.assertAccountHasBudget("u", db({ role, spend: 500 })))).to.equal(null);
    }
    expect(await rejection(() => AccountLimitsSvc.assertAccountHasBudget("u", db({ spend: 500 })))).to.equal(null);
  });

  it("allowanceInfo reports remainingUsd and consumedPct, floored/capped", async () => {
    const info = await AccountLimitsSvc.allowanceInfo("u", db({ role: "LAWYER", spend: 15 }));
    expect(info.limited).to.equal(true);
    expect(info.locked).to.equal(false);
    expect(info.remainingUsd).to.equal(5);
    expect(info.consumedPct).to.equal(75);

    const over = await AccountLimitsSvc.allowanceInfo("u", db({ role: "LAWYER", spend: 40 }));
    expect(over.locked).to.equal(true);
    expect(over.remainingUsd).to.equal(0);
    expect(over.consumedPct).to.equal(100);
  });

  it("allowanceInfo is unlimited for a non-lawyer", async () => {
    const info = await AccountLimitsSvc.allowanceInfo("u", db({ role: "USER", spend: 500 }));
    expect(info).to.deep.equal({ limited: false, locked: false, remainingUsd: null, consumedPct: null, thresholdUsd: 0 });
  });

  it("lets staff/top-up add to one account's allowance", async () => {
    const updated = await AccountLimitsSvc.grantExtraAllowance("u", 20, db({ role: "LAWYER" }));
    expect(updated.extraAiAllowanceUsd).to.equal(20);
  });
});

describe("which requests a spent account holds back", () => {
  it("holds back writes that can start AI work", () => {
    for (const [method, rest] of [
      ["POST", "/refresh"],
      ["POST", "/timeline/generate"],
      ["POST", "/mind-map/generate"],
      ["POST", "/findings/regenerate"],
      ["POST", "/documents"],
      ["PUT", "/evidence/matrix/abc"],
      ["GET", "/export"],
    ]) {
      expect(startsAiWork(method, rest), `${method} ${rest}`).to.equal(true);
    }
  });

  it("keeps reads, deletes and housekeeping open", () => {
    for (const [method, rest] of [
      ["GET", ""],
      ["GET", "/timeline"],
      ["GET", "/snapshot"],
      ["DELETE", "/documents/abc"],
      ["DELETE", ""],
      ["PATCH", ""],
      ["POST", "/opened"],
      ["POST", "/archive"],
      ["POST", "/unarchive"],
      ["POST", "/access"],
      ["POST", "/shares"],
    ]) {
      expect(startsAiWork(method, rest), `${method} ${rest}`).to.equal(false);
    }
  });
});
