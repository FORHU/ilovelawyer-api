import { expect } from "chai";
import { describe, it } from "mocha";
import CaseLimitsSvc from "../src/services/case-limits.service";
import { startsAiWork } from "../src/middleware/case-spend-limit.middleware";

/** A stand-in for the database: one user with a role and a number of cases, one case with an owner's
 * role, an extra allowance and a recorded AI spend. */
const db = (opts: { role?: string; cases?: number; spend?: number | null; extra?: number; hasCase?: boolean }) =>
  ({
    user: { findUnique: async () => (opts.role ? { role: opts.role } : null) },
    case: {
      count: async () => opts.cases ?? 0,
      findUnique: async () => (opts.hasCase === false ? null : { extraAiAllowanceUsd: opts.extra ?? 0, user: opts.role ? { role: opts.role } : null }),
      update: async (args: { data: { extraAiAllowanceUsd: { increment: number } } }) => ({ id: "c", caseName: "n", extraAiAllowanceUsd: args.data.extraAiAllowanceUsd.increment }),
    },
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
    expect(await rejection(() => CaseLimitsSvc.assertCanCreateCase("u", db({ role: "LAWYER", cases: 2 }), 3))).to.equal(null);
  });

  it("stops a lawyer who already owns the limit, with a reason a client can branch on", async () => {
    const err = await rejection(() => CaseLimitsSvc.assertCanCreateCase("u", db({ role: "LAWYER", cases: 3 }), 3));
    expect(err?.statusCode).to.equal(403);
    expect(err?.code).to.equal("CASE_LIMIT_REACHED");
  });

  it("keeps a lawyer who is already over the limit out of creating more, without touching their cases", async () => {
    const err = await rejection(() => CaseLimitsSvc.assertCanCreateCase("u", db({ role: "LAWYER", cases: 7 }), 3));
    expect(err?.code).to.equal("CASE_LIMIT_REACHED");
  });

  it("never limits staff or other roles", async () => {
    for (const role of ["ADMIN", "USER"]) {
      expect(await rejection(() => CaseLimitsSvc.assertCanCreateCase("u", db({ role, cases: 50 }), 3))).to.equal(null);
    }
  });

  it("is off when the limit is 0", async () => {
    expect(await rejection(() => CaseLimitsSvc.assertCanCreateCase("u", db({ role: "LAWYER", cases: 50 }), 0))).to.equal(null);
  });
});

describe("a case's AI allowance", () => {
  it("lets a lawyer's case work while under the allowance", async () => {
    expect(await rejection(() => CaseLimitsSvc.assertCaseHasBudget("c", db({ role: "LAWYER", spend: 19.99 }), 20))).to.equal(null);
    expect(await rejection(() => CaseLimitsSvc.assertCaseHasBudget("c", db({ role: "LAWYER", spend: null }), 20))).to.equal(null);
  });

  it("stops new AI work at the allowance", async () => {
    const err = await rejection(() => CaseLimitsSvc.assertCaseHasBudget("c", db({ role: "LAWYER", spend: 20 }), 20));
    expect(err?.statusCode).to.equal(403);
    expect(err?.code).to.equal("CASE_ALLOWANCE_REACHED");
  });

  it("never states the amount, the amount used or the amount left", async () => {
    const err = await rejection(() => CaseLimitsSvc.assertCaseHasBudget("c", db({ role: "LAWYER", spend: 23.456 }), 20));
    expect(err?.message).to.not.match(/\d|\$|USD|dollar/i);
    expect(err?.details).to.equal(undefined);
    expect(JSON.stringify(err)).to.not.match(/20|23\.456/);
  });

  it("tells the lawyer to contact us", async () => {
    const err = await rejection(() => CaseLimitsSvc.assertCaseHasBudget("c", db({ role: "LAWYER", spend: 20 }), 20));
    expect(err?.message).to.match(/contact us/i);
  });

  it("counts what staff added to this case on top of the standard allowance", async () => {
    expect(await rejection(() => CaseLimitsSvc.assertCaseHasBudget("c", db({ role: "LAWYER", spend: 25, extra: 20 }), 20))).to.equal(null);
    const err = await rejection(() => CaseLimitsSvc.assertCaseHasBudget("c", db({ role: "LAWYER", spend: 40, extra: 20 }), 20));
    expect(err?.code).to.equal("CASE_ALLOWANCE_REACHED");
  });

  it("does not limit a case owned by staff, another role, or nobody", async () => {
    for (const role of ["ADMIN", "USER"]) {
      expect(await rejection(() => CaseLimitsSvc.assertCaseHasBudget("c", db({ role, spend: 500 }), 20))).to.equal(null);
    }
    expect(await rejection(() => CaseLimitsSvc.assertCaseHasBudget("c", db({ spend: 500 }), 20))).to.equal(null);
    expect(await rejection(() => CaseLimitsSvc.assertCaseHasBudget("c", db({ hasCase: false }), 20))).to.equal(null);
  });

  it("is off when the allowance is 0", async () => {
    expect(await rejection(() => CaseLimitsSvc.assertCaseHasBudget("c", db({ role: "LAWYER", spend: 500 }), 0))).to.equal(null);
  });

  it("lets staff add to one case's allowance", async () => {
    const updated = await CaseLimitsSvc.grantExtraAllowance("c", 20, db({ role: "LAWYER" }));
    expect(updated.extraAiAllowanceUsd).to.equal(20);
  });
});

describe("which requests a spent case holds back", () => {
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
