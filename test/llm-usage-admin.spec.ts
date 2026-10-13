/** The admin LLM usage endpoints (#405, epic #399): query validation and the default range
 * (controller), and how rows are folded into totals and breakdowns (LlmUsageSvc.list / summary).
 * No live Postgres: LlmUsageRepo is monkeypatched on its CommonJS module object, and the handlers
 * are called with a fake request and response, same idiom as test/security-audit-service.spec.ts.
 * The SQL itself (groupBy, the per-day query) is not exercised here.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import LlmUsageCtrl from "../src/controllers/llm-usage.controller";
import LlmUsageSvc from "../src/services/llm-usage.service";
import LlmUsageRepo, { LlmUsageGroup } from "../src/repositories/llm-usage.repository";
import HttpError from "../src/utils/http-error";

type RepoKey = keyof typeof LlmUsageRepo;

function stash(keys: RepoKey[]) {
  const saved = keys.map((k) => [k, (LlmUsageRepo as any)[k]] as const);
  return () => saved.forEach(([k, v]) => ((LlmUsageRepo as any)[k] = v));
}

const group = (key: string | null, source: "ESTIMATED" | "REPORTED", calls: number, totalTokens: number, costUsd = 0, unpricedCalls = 0): LlmUsageGroup => ({
  key,
  source,
  calls,
  inputTokens: totalTokens - 1,
  outputTokens: 1,
  cachedInputTokens: 0,
  totalTokens,
  costUsd,
  unpricedCalls,
});

function call(handler: (req: any, res: any) => Promise<unknown>, query: Record<string, unknown>) {
  let status = 0;
  let body: any;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(value: unknown) {
      body = value;
      return this;
    },
  };
  return handler({ query }, res).then(() => ({ status, body }));
}

describe("admin LLM usage endpoints", () => {
  let restore: () => void;
  let listFilters: any[];
  let summaryFilters: any[];

  beforeEach(() => {
    listFilters = [];
    summaryFilters = [];
    restore = stash(["list", "count", "totalsBySource", "countUnpriced", "groupBy", "topBy", "byDay", "findOrganizationNames", "findUserNames"]);
    const repo = LlmUsageRepo as any;
    repo.list = async (filter: unknown, take: number, skip: number) => {
      listFilters.push({ filter, take, skip });
      return [
        { id: "r1", createdAt: new Date("2026-10-11T00:00:00Z"), organizationId: "org-1", userId: "user-1", feature: "chat" },
        { id: "r2", createdAt: new Date("2026-10-10T00:00:00Z"), organizationId: "gone-org", userId: null, feature: "embedding" },
      ];
    };
    repo.count = async () => 45;
    repo.totalsBySource = async (filter: unknown) => {
      summaryFilters.push(filter);
      return [group(null, "ESTIMATED", 3, 300, 0), group(null, "REPORTED", 2, 100, 0.5)];
    };
    repo.countUnpriced = async () => 3;
    repo.groupBy = async (_filter: unknown, dimension: string) =>
      dimension === "model"
        ? [group("gpt-x", "REPORTED", 2, 100, 0.5), group(null, "ESTIMATED", 3, 300, 0, 3)]
        : [group("OPENAI", "ESTIMATED", 3, 300), group("OPENAI", "REPORTED", 1, 40), group("TYPESAFE", "REPORTED", 1, 60)];
    repo.topBy = async (_f: unknown, dimension: string) => (dimension === "organizationId" ? [group("org-1", "REPORTED", 5, 400, 0.5)] : [group("user-1", "REPORTED", 5, 400, 0.5)]);
    repo.byDay = async () => [
      { day: new Date("2026-10-10T00:00:00Z"), source: "ESTIMATED", calls: 3, totalTokens: 300, costUsd: 0 },
      { day: new Date("2026-10-10T00:00:00Z"), source: "REPORTED", calls: 1, totalTokens: 40, costUsd: 0.25 },
      { day: new Date("2026-10-09T00:00:00Z"), source: "REPORTED", calls: 1, totalTokens: 60, costUsd: 0.25 },
    ];
    repo.findOrganizationNames = async () => [{ id: "org-1", name: "Acme LLP" }];
    repo.findUserNames = async () => [{ id: "user-1", email: "a@firm.test", name: null }];
  });

  afterEach(() => restore());

  describe("GET /llm-usage", () => {
    it("returns the page envelope with names resolved, and null for ids that no longer exist", async () => {
      const { status, body } = await call(LlmUsageCtrl.list, { page: "2", limit: "10" });
      expect(status).to.equal(200);
      expect(body).to.include({ total: 45, page: 2, pageSize: 10, totalPages: 5 });
      expect(listFilters[0]).to.include({ take: 10, skip: 10 });
      expect(body.rows[0]).to.include({ id: "r1", organizationName: "Acme LLP", userName: "a@firm.test" });
      expect(body.rows[1]).to.include({ id: "r2", organizationName: null, userName: null });
    });

    it("defaults to page 1 of 25 and passes every filter through", async () => {
      await call(LlmUsageCtrl.list, { provider: "OPENAI", model: "m", feature: "chat", source: "ESTIMATED", organizationId: "o", userId: "u", caseId: "c" });
      expect(listFilters[0]).to.include({ take: 25, skip: 0 });
      expect(listFilters[0].filter).to.include({ provider: "OPENAI", model: "m", feature: "chat", source: "ESTIMATED", organizationId: "o", userId: "u", caseId: "c" });
    });

    it("refuses a page size above the cap, an unknown provider or source, and a bad date, with a 400", async () => {
      for (const query of [{ limit: "101" }, { provider: "ANTHROPIC" }, { source: "GUESSED" }, { from: "not-a-date" }, { page: "0" }, { bogus: "1" }]) {
        let thrown: unknown;
        try {
          await call(LlmUsageCtrl.list, query);
        } catch (err) {
          thrown = err;
        }
        expect(thrown, JSON.stringify(query)).to.be.instanceOf(HttpError);
        expect((thrown as HttpError).statusCode).to.equal(400);
      }
    });

    it("refuses a range that ends before it starts", async () => {
      let thrown: unknown;
      try {
        await call(LlmUsageCtrl.list, { from: "2026-10-11", to: "2026-10-01" });
      } catch (err) {
        thrown = err;
      }
      expect((thrown as HttpError).statusCode).to.equal(400);
    });
  });

  describe("GET /llm-usage/summary", () => {
    it("defaults to the last 30 days", async () => {
      const before = Date.now();
      const { body } = await call(LlmUsageCtrl.summary, {});
      const days = (before - new Date(body.range.from).getTime()) / 86_400_000;
      expect(days).to.be.closeTo(30, 0.01);
      expect(body.range.to).to.equal(null);
      expect(summaryFilters[0].from).to.be.instanceOf(Date);
    });

    it("keeps an explicit range", async () => {
      await call(LlmUsageCtrl.summary, { from: "2026-09-01T00:00:00Z", to: "2026-10-01T00:00:00Z" });
      expect(summaryFilters[0].from.toISOString()).to.equal("2026-09-01T00:00:00.000Z");
      expect(summaryFilters[0].to.toISOString()).to.equal("2026-10-01T00:00:00.000Z");
    });

    it("totals every call and splits them into estimated and reported", async () => {
      const { status, body } = await call(LlmUsageCtrl.summary, {});
      expect(status).to.equal(200);
      expect(body.totals).to.deep.include({ tokens: 400, calls: 5, costUsd: 0.5, unpricedCalls: 3 });
      expect(body.totals.estimated).to.deep.include({ tokens: 300, calls: 3 });
      expect(body.totals.reported).to.deep.include({ tokens: 100, calls: 2, costUsd: 0.5 });
    });

    it("folds the per-source groups into one row per key, biggest first, keeping the split", async () => {
      const { body } = await call(LlmUsageCtrl.summary, {});
      expect(body.byProvider.map((r: any) => r.key)).to.deep.equal(["OPENAI", "TYPESAFE"]);
      const openai = body.byProvider[0];
      expect(openai).to.deep.include({ tokens: 340, calls: 4 });
      expect(openai.estimated.tokens).to.equal(300);
      expect(openai.reported.tokens).to.equal(40);
    });

    it("keeps a call with no model as its own row instead of dropping it, and says how many of its calls have no price", async () => {
      const { body } = await call(LlmUsageCtrl.summary, {});
      expect(body.byModel.map((r: any) => r.key)).to.deep.equal([null, "gpt-x"]);
      // Every call with no model is unpriced, so the page can print a dash instead of $0.00.
      expect(body.byModel[0]).to.include({ calls: 3, unpricedCalls: 3 });
      expect(body.byModel[1]).to.include({ calls: 2, unpricedCalls: 0 });
    });

    it("sums the per-day rows by date, oldest first", async () => {
      const { body } = await call(LlmUsageCtrl.summary, {});
      expect(body.byDay).to.deep.equal([
        { day: "2026-10-09", calls: 1, tokens: 60, costUsd: 0.25, estimatedTokens: 0, reportedTokens: 60 },
        { day: "2026-10-10", calls: 4, tokens: 340, costUsd: 0.25, estimatedTokens: 300, reportedTokens: 40 },
      ]);
    });

    it("names the top organizations and users", async () => {
      const { body } = await call(LlmUsageCtrl.summary, {});
      expect(body.topOrganizations[0]).to.include({ key: "org-1", name: "Acme LLP", tokens: 400 });
      expect(body.topUsers[0]).to.include({ key: "user-1", name: "a@firm.test" });
    });
  });

  describe("LlmUsageSvc.summary with no rows", () => {
    it("returns zeros and empty lists", async () => {
      const repo = LlmUsageRepo as any;
      repo.totalsBySource = async () => [];
      repo.countUnpriced = async () => 0;
      repo.groupBy = async () => [];
      repo.topBy = async () => [];
      repo.byDay = async () => [];
      const summary = await LlmUsageSvc.summary({});
      expect(summary.totals).to.deep.include({ tokens: 0, calls: 0, costUsd: 0, unpricedCalls: 0 });
      expect(summary.byModel).to.deep.equal([]);
      expect(summary.byDay).to.deep.equal([]);
    });
  });
});
