import { expect } from "chai";
import { describe, it } from "mocha";
import AccountLimitsSvc from "../src/services/account-limits.service";
import { startsAiWork } from "../src/middleware/account-spend-limit.middleware";

/** A stand-in for the database: one user with a role, a tenant (or not), a tier's case limit and
 * included allowance (or none), a number of cases, an extra (top-up) AI allowance and a recorded
 * AI spend. `tenantId: null` (the default here) keeps both limits on the legacy
 * MAX_CASES_PER_ACCOUNT / CASE_SPEND_LIMIT_USD off-switch fallback path, skipping the
 * tier-resolution path entirely — that path is exercised by the `tenantId` cases below. */
const db = (opts: {
  role?: string;
  cases?: number;
  spend?: number | null;
  extra?: number;
  tenantId?: string | null;
  caseLimit?: number;
  includedAllowanceUsd?: number;
  hasPlan?: boolean;
  allowancePeriodStart?: Date | null;
  caseLimitNotifiedAt?: Date | null;
}) =>
  ({
    user: {
      findUnique: async () =>
        opts.role
          ? {
              role: opts.role,
              extraAiAllowanceUsd: opts.extra ?? 0,
              tenantId: opts.tenantId ?? null,
              allowancePeriodStart: opts.allowancePeriodStart ?? null,
              caseLimitNotifiedAt: opts.caseLimitNotifiedAt ?? null,
              paymentPlan: opts.hasPlan === false || !opts.tenantId ? null : { caseLimit: opts.caseLimit ?? 0, includedAllowanceUsd: opts.includedAllowanceUsd ?? 0 },
            }
          : null,
      update: async (args: { data: { extraAiAllowanceUsd?: { increment: number } } }) => ({ id: "u", email: "u@example.com", extraAiAllowanceUsd: args.data.extraAiAllowanceUsd?.increment }),
    },
    case: { count: async () => opts.cases ?? 0 },
    llmUsage: { aggregate: async () => ({ _sum: { estimatedCostUsd: opts.spend ?? null } }) },
    notification: { create: async (args: { data: unknown }) => ({ id: "n1", ...(args.data as object) }) },
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
  it("lets a lawyer create a case while under their tier's limit", async () => {
    expect(await rejection(() => AccountLimitsSvc.assertCanCreateCase("u", db({ role: "LAWYER", tenantId: "t1", caseLimit: 3, cases: 2 })))).to.equal(null);
  });

  it("stops a lawyer who already owns their tier's limit, with a reason a client can branch on", async () => {
    const err = await rejection(() => AccountLimitsSvc.assertCanCreateCase("u", db({ role: "LAWYER", tenantId: "t1", caseLimit: 3, cases: 3 })));
    expect(err?.statusCode).to.equal(403);
    expect(err?.code).to.equal("CASE_LIMIT_REACHED");
  });

  it("keeps a lawyer who is already over the limit out of creating more, without touching their cases", async () => {
    const err = await rejection(() => AccountLimitsSvc.assertCanCreateCase("u", db({ role: "LAWYER", tenantId: "t1", caseLimit: 3, cases: 7 })));
    expect(err?.code).to.equal("CASE_LIMIT_REACHED");
  });

  it("never limits staff or other roles", async () => {
    for (const role of ["ADMIN", "USER"]) {
      expect(await rejection(() => AccountLimitsSvc.assertCanCreateCase("u", db({ role, tenantId: "t1", caseLimit: 3, cases: 50 })))).to.equal(null);
    }
  });

  it("is unlimited for a tenant-less lawyer when MAX_CASES_PER_ACCOUNT is off (0, the default)", async () => {
    expect(await rejection(() => AccountLimitsSvc.assertCanCreateCase("u", db({ role: "LAWYER", cases: 50 })))).to.equal(null);
  });

  it("a tier with a 0 caseLimit is unlimited, same as off", async () => {
    expect(await rejection(() => AccountLimitsSvc.assertCanCreateCase("u", db({ role: "LAWYER", tenantId: "t1", caseLimit: 0, cases: 50 })))).to.equal(null);
  });

  it("a tenant-scoped lawyer with no tier (canceled) falls back to MAX_CASES_PER_ACCOUNT (0, off)", async () => {
    expect(await rejection(() => AccountLimitsSvc.assertCanCreateCase("u", db({ role: "LAWYER", tenantId: "t1", hasPlan: false, cases: 50 })))).to.equal(null);
  });

  it("sends a one-time notice the first time a grandfathered lawyer is over their tier's limit, then never again", async () => {
    const notified: unknown[] = [];
    const stamped: Date[] = [];
    const base = db({ role: "LAWYER", tenantId: "t1", caseLimit: 3, cases: 7 }) as unknown as { user: { update: (args: unknown) => Promise<unknown> }; notification: { create: (args: { data: unknown }) => Promise<unknown> }; case: unknown; llmUsage: unknown };
    const spyDb = {
      ...base,
      notification: { create: async (args: { data: unknown }) => { notified.push(args.data); return { id: "n1", ...(args.data as object) }; } },
      user: { ...base.user, update: async (args: { data: { caseLimitNotifiedAt?: Date } }) => { if (args.data.caseLimitNotifiedAt) stamped.push(args.data.caseLimitNotifiedAt); return {}; } },
    };
    await rejection(() => AccountLimitsSvc.assertCanCreateCase("u", spyDb as never));
    expect(notified.length).to.equal(1);
    expect(stamped.length).to.equal(1);

    // Already notified (caseLimitNotifiedAt set) — must not notify again.
    const already = db({ role: "LAWYER", tenantId: "t1", caseLimit: 3, cases: 7, caseLimitNotifiedAt: new Date() }) as unknown as object;
    const notified2: unknown[] = [];
    const spyDb2 = { ...already, notification: { create: async (args: { data: unknown }) => { notified2.push(args.data); return {}; } } };
    await rejection(() => AccountLimitsSvc.assertCanCreateCase("u", spyDb2 as never));
    expect(notified2.length).to.equal(0);
  });
});

describe("an account's AI allowance", () => {
  it("lets a lawyer's account work while under their tier's allowance", async () => {
    expect(await rejection(() => AccountLimitsSvc.assertAccountHasBudget("u", db({ role: "LAWYER", tenantId: "t1", includedAllowanceUsd: 20, spend: 19.99 })))).to.equal(null);
    expect(await rejection(() => AccountLimitsSvc.assertAccountHasBudget("u", db({ role: "LAWYER", tenantId: "t1", includedAllowanceUsd: 20, spend: null })))).to.equal(null);
  });

  it("stops new AI work at the tier's allowance", async () => {
    const err = await rejection(() => AccountLimitsSvc.assertAccountHasBudget("u", db({ role: "LAWYER", tenantId: "t1", includedAllowanceUsd: 20, spend: 20 })));
    expect(err?.statusCode).to.equal(403);
    expect(err?.code).to.equal("ACCOUNT_ALLOWANCE_REACHED");
  });

  it("never states the ceiling as a bare number in the error", async () => {
    const err = await rejection(() => AccountLimitsSvc.assertAccountHasBudget("u", db({ role: "LAWYER", tenantId: "t1", includedAllowanceUsd: 20, spend: 23.456 })));
    expect(err?.message).to.not.match(/\d|\$|USD|dollar/i);
    expect(err?.details).to.equal(undefined);
  });

  it("tells the lawyer to top up", async () => {
    const err = await rejection(() => AccountLimitsSvc.assertAccountHasBudget("u", db({ role: "LAWYER", tenantId: "t1", includedAllowanceUsd: 20, spend: 20 })));
    expect(err?.message).to.match(/top up/i);
  });

  it("counts top-up credit on top of the tier's allowance", async () => {
    expect(await rejection(() => AccountLimitsSvc.assertAccountHasBudget("u", db({ role: "LAWYER", tenantId: "t1", includedAllowanceUsd: 20, spend: 25, extra: 20 })))).to.equal(null);
    const err = await rejection(() => AccountLimitsSvc.assertAccountHasBudget("u", db({ role: "LAWYER", tenantId: "t1", includedAllowanceUsd: 20, spend: 40, extra: 20 })));
    expect(err?.code).to.equal("ACCOUNT_ALLOWANCE_REACHED");
  });

  it("locks a canceled/never-subscribed lawyer (no tier, no top-up credit) instead of treating them as unlimited", async () => {
    const err = await rejection(() => AccountLimitsSvc.assertAccountHasBudget("u", db({ role: "LAWYER", tenantId: "t1", hasPlan: false, spend: 0 })));
    expect(err?.code).to.equal("ACCOUNT_ALLOWANCE_REACHED");
    const info = await AccountLimitsSvc.allowanceInfo("u", db({ role: "LAWYER", tenantId: "t1", hasPlan: false, spend: 0 }));
    expect(info).to.deep.equal({ limited: true, locked: true, remainingUsd: 0, consumedPct: 100, thresholdUsd: 0 });
  });

  it("a canceled lawyer with leftover top-up credit can still work until that credit runs out", async () => {
    expect(await rejection(() => AccountLimitsSvc.assertAccountHasBudget("u", db({ role: "LAWYER", tenantId: "t1", hasPlan: false, extra: 10, spend: 5 })))).to.equal(null);
    const err = await rejection(() => AccountLimitsSvc.assertAccountHasBudget("u", db({ role: "LAWYER", tenantId: "t1", hasPlan: false, extra: 10, spend: 10 })));
    expect(err?.code).to.equal("ACCOUNT_ALLOWANCE_REACHED");
  });

  it("sums spend only from the current billing period when allowancePeriodStart is set", async () => {
    let sawCreatedAtFilter = false;
    const base = db({ role: "LAWYER", tenantId: "t1", includedAllowanceUsd: 20, spend: 5, allowancePeriodStart: new Date("2026-01-01") }) as unknown as { user: { findUnique: () => Promise<unknown> } };
    const spyDb = {
      ...base,
      llmUsage: {
        aggregate: async (args: { where?: { createdAt?: unknown } }) => {
          sawCreatedAtFilter = Boolean(args.where?.createdAt);
          return { _sum: { estimatedCostUsd: 5 } };
        },
      },
    };
    await AccountLimitsSvc.allowanceInfo("u", spyDb as never);
    expect(sawCreatedAtFilter).to.equal(true);
  });

  it("does not limit staff, another role, or a user that doesn't exist", async () => {
    for (const role of ["ADMIN", "USER"]) {
      expect(await rejection(() => AccountLimitsSvc.assertAccountHasBudget("u", db({ role, spend: 500 })))).to.equal(null);
    }
    expect(await rejection(() => AccountLimitsSvc.assertAccountHasBudget("u", db({ spend: 500 })))).to.equal(null);
  });

  it("allowanceInfo reports remainingUsd and consumedPct, floored/capped", async () => {
    const info = await AccountLimitsSvc.allowanceInfo("u", db({ role: "LAWYER", tenantId: "t1", includedAllowanceUsd: 20, spend: 15 }));
    expect(info.limited).to.equal(true);
    expect(info.locked).to.equal(false);
    expect(info.remainingUsd).to.equal(5);
    expect(info.consumedPct).to.equal(75);

    const over = await AccountLimitsSvc.allowanceInfo("u", db({ role: "LAWYER", tenantId: "t1", includedAllowanceUsd: 20, spend: 40 }));
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
