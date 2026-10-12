/** GET /api/admin/llm-usage and /api/admin/llm-usage/summary (#405, epic #399). Runs the real routes
 * against the real database, like test/admin-export-route.spec.ts: it creates its own users and
 * LlmUsage rows (under one throwaway organizationId, which every request filters on so other rows
 * in the database cannot change the numbers) and removes them afterwards. Rows are written with
 * prisma.llmUsage.createMany directly, which bypasses the repo test double.
 */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after } from "mocha";
import request from "supertest";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import loginToken from "../src/utils/loginToken";

const DAY = 24 * 60 * 60 * 1000;

describe("admin LLM usage routes", () => {
  const adminId = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const namedUserId = crypto.randomUUID();
  const goneUserId = crypto.randomUUID(); // never created: a deleted account
  const orgId = `llm-usage-spec-${crypto.randomUUID()}`;
  // A row naming no user and no organization (background work nobody could be attributed to). Its
  // feature is unique to this run so the "none" filters can be checked against it alone.
  const noneFeature = `f-none-${crypto.randomUUID()}`;
  const now = Date.now();
  const asUser = (id: string) => ({ Authorization: `Bearer ${loginToken(id, false).accessToken}` });
  const get = (path: string, as: string = adminId) => request(app).get(`/api/admin${path}`).set(asUser(as));

  const row = (over: Record<string, unknown>) => ({
    provider: "OPENAI" as const,
    via: "direct",
    model: null as string | null,
    feature: "chat",
    source: "REPORTED" as const,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: null as number | null,
    totalTokens: 0,
    passCount: null as number | null,
    estimatedCostUsd: null as number | null,
    userId: namedUserId as string | null,
    organizationId: orgId,
    ...over,
  });

  before(async () => {
    await prisma.user.create({ data: { id: adminId, email: `adm-${adminId}@example.com`, username: `adm-${adminId}`, role: "ADMIN" } });
    await prisma.user.create({ data: { id: memberId, email: `mem-${memberId}@example.com`, username: `mem-${memberId}` } });
    await prisma.user.create({ data: { id: namedUserId, email: `named-${namedUserId}@example.com`, username: `named-${namedUserId}`, name: "Named Person" } });
    await prisma.llmUsage.createMany({
      data: [
        // A: priced, reported, 2 days ago
        row({ createdAt: new Date(now - 2 * DAY), model: "gpt-5.6-luna", feature: "f-a", inputTokens: 1000, outputTokens: 100, cachedInputTokens: 400, totalTokens: 1100, estimatedCostUsd: 0.5 }),
        // B: Chat Wonder estimate with no model and no price, 2 days ago
        row({ createdAt: new Date(now - 2 * DAY), via: "chat-wonder", source: "ESTIMATED", feature: "f-b", inputTokens: 2000, outputTokens: 200, totalTokens: 2200, passCount: 3 }),
        // C: Jev, deleted user, 1 day ago
        row({ createdAt: new Date(now - 1 * DAY), provider: "TYPESAFE", model: "jev-1", feature: "f-c", inputTokens: 300, totalTokens: 300, estimatedCostUsd: 0.0000126, userId: goneUserId }),
        // E: no user and no organization
        row({ createdAt: new Date(now - 1 * DAY), feature: noneFeature, userId: null, organizationId: null, inputTokens: 7, totalTokens: 7 }),
        // D: outside the default 30-day range
        row({ createdAt: new Date(now - 40 * DAY), model: "gpt-5.6-luna", feature: "f-a", inputTokens: 500, outputTokens: 50, totalTokens: 550, estimatedCostUsd: 0.25 }),
      ],
    });
  });

  after(async () => {
    await prisma.llmUsage.deleteMany({ where: { OR: [{ organizationId: orgId }, { feature: noneFeature }] } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, memberId, namedUserId] } } });
  });

  describe("access", () => {
    it("refuses a signed-out caller", async () => {
      await request(app).get("/api/admin/llm-usage").expect(401);
      await request(app).get("/api/admin/llm-usage/summary").expect(401);
    });

    it("refuses a signed-in non-admin with 403", async () => {
      await get(`/llm-usage?organizationId=${orgId}`, memberId).expect(403);
      await get(`/llm-usage/summary?organizationId=${orgId}`, memberId).expect(403);
    });
  });

  describe("GET /llm-usage/summary", () => {
    it("totals the default 30 days, splits estimated from reported, and counts unpriced calls", async () => {
      const { body } = await get(`/llm-usage/summary?organizationId=${orgId}`).expect(200);
      expect(body.totals).to.deep.include({ tokens: 3600, inputTokens: 3300, outputTokens: 300, cachedInputTokens: 400, calls: 3, unpricedCalls: 1 });
      expect(body.totals.costUsd).to.be.closeTo(0.5 + 0.0000126, 1e-9);
      expect(body.totals.estimated).to.deep.include({ tokens: 2200, calls: 1 });
      expect(body.totals.reported).to.deep.include({ tokens: 1400, calls: 2 });
      expect(new Date(body.range.from).getTime()).to.be.closeTo(now - 30 * DAY, 60_000);
    });

    it("includes the older row when the range reaches back to it", async () => {
      const from = new Date(now - 60 * DAY).toISOString();
      const { body } = await get(`/llm-usage/summary?organizationId=${orgId}&from=${from}`).expect(200);
      expect(body.totals).to.deep.include({ tokens: 4150, calls: 4 });
    });

    it("breaks down by provider, model and feature, keeping a call with no model", async () => {
      const { body } = await get(`/llm-usage/summary?organizationId=${orgId}`).expect(200);
      expect(body.byProvider.map((r: any) => [r.key, r.tokens, r.calls])).to.deep.equal([
        ["OPENAI", 3300, 2],
        ["TYPESAFE", 300, 1],
      ]);
      // Row B (Chat Wonder estimate: no model, no price) is the only unpriced call.
      expect(body.byProvider.map((r: any) => [r.key, r.unpricedCalls])).to.deep.equal([
        ["OPENAI", 1],
        ["TYPESAFE", 0],
      ]);
      expect(body.byModel.map((r: any) => [r.key, r.tokens])).to.deep.equal([
        [null, 2200],
        ["gpt-5.6-luna", 1100],
        ["jev-1", 300],
      ]);
      expect(body.byModel[0].estimated.tokens).to.equal(2200);
      expect(body.byModel.map((r: any) => [r.key, r.unpricedCalls])).to.deep.equal([
        [null, 1],
        ["gpt-5.6-luna", 0],
        ["jev-1", 0],
      ]);
      expect(body.byFeature.map((r: any) => r.key).sort()).to.deep.equal(["f-a", "f-b", "f-c"]);
    });

    it("sums per UTC day, oldest first, split by source", async () => {
      const { body } = await get(`/llm-usage/summary?organizationId=${orgId}`).expect(200);
      const day = (offset: number) => new Date(now - offset * DAY).toISOString().slice(0, 10);
      expect(body.byDay).to.deep.equal([
        { day: day(2), calls: 2, tokens: 3300, costUsd: 0.5, estimatedTokens: 2200, reportedTokens: 1100 },
        { day: day(1), calls: 1, tokens: 300, costUsd: 0.0000126, estimatedTokens: 0, reportedTokens: 300 },
      ]);
    });

    it("names the top users, and leaves a deleted account's name null", async () => {
      const { body } = await get(`/llm-usage/summary?organizationId=${orgId}`).expect(200);
      expect(body.topUsers.map((r: any) => [r.key, r.name, r.tokens])).to.deep.equal([
        [namedUserId, "Named Person", 3300],
        [goneUserId, null, 300],
      ]);
      expect(body.topOrganizations.map((r: any) => [r.key, r.name, r.tokens])).to.deep.equal([[orgId, null, 3600]]);
    });

    it("keeps the top lists inside the filter, including a filter on the listed column itself", async () => {
      // A second organization's usage must not show up in a summary filtered to the first.
      const otherOrg = `${orgId}-other`;
      await prisma.llmUsage.create({ data: row({ organizationId: otherOrg, userId: memberId, feature: "f-x", inputTokens: 10, totalTokens: 10, createdAt: new Date(now - DAY) }) });
      try {
        const byOrg = (await get(`/llm-usage/summary?organizationId=${orgId}`).expect(200)).body;
        expect(byOrg.topOrganizations.map((r: any) => r.key)).to.deep.equal([orgId]);
        expect(byOrg.topUsers.map((r: any) => r.key)).to.not.include(memberId);
        const byUser = (await get(`/llm-usage/summary?organizationId=${orgId}&userId=${namedUserId}`).expect(200)).body;
        expect(byUser.topUsers.map((r: any) => r.key)).to.deep.equal([namedUserId]);
        const unfiltered = (await get(`/llm-usage/summary?organizationId=${otherOrg}`).expect(200)).body;
        expect(unfiltered.topOrganizations.map((r: any) => r.key)).to.deep.equal([otherOrg]);
      } finally {
        await prisma.llmUsage.deleteMany({ where: { organizationId: otherOrg } });
      }
    });

    it("applies each filter", async () => {
      const q = (extra: string) => get(`/llm-usage/summary?organizationId=${orgId}&${extra}`).expect(200).then((r) => r.body.totals);
      expect(await q("provider=TYPESAFE")).to.deep.include({ calls: 1, tokens: 300 });
      expect(await q("source=ESTIMATED")).to.deep.include({ calls: 1, tokens: 2200 });
      expect(await q("model=gpt-5.6-luna")).to.deep.include({ calls: 1, tokens: 1100 });
      expect(await q("feature=f-b")).to.deep.include({ calls: 1, tokens: 2200 });
      expect(await q(`userId=${goneUserId}`)).to.deep.include({ calls: 1, tokens: 300 });
      const noMatch = await q("feature=does-not-exist");
      expect(noMatch).to.deep.include({ calls: 0, tokens: 0, costUsd: 0 });
    });

    it("returns empty lists and zero totals for a range with no rows", async () => {
      const { body } = await get(`/llm-usage/summary?organizationId=${orgId}-none`).expect(200);
      expect(body.totals).to.deep.include({ calls: 0, tokens: 0 });
      expect(body.byDay).to.deep.equal([]);
      expect(body.byModel).to.deep.equal([]);
    });

    it("refuses a bad query with a 400", async () => {
      await get("/llm-usage/summary?provider=ANTHROPIC").expect(400);
      await get("/llm-usage/summary?from=2026-10-11&to=2026-10-01").expect(400);
    });
  });

  describe("who filters", () => {
    it("lists the users and organizations in the range by name, and says whether rows name none", async () => {
      const { body } = await get("/llm-usage/people").expect(200);
      expect(body.users).to.deep.include({ id: namedUserId, label: "Named Person", email: `named-${namedUserId}@example.com` });
      expect(body.users.find((u: any) => u.id === goneUserId)).to.include({ label: "Deleted account", email: null });
      expect(body.organizations).to.deep.include({ id: orgId, label: "Deleted organization" });
      expect(body.hasNoUser).to.equal(true);
      expect(body.hasNoOrganization).to.equal(true);
    });

    it("narrows the lists to each other: an organization lists only its users, a user only their organizations", async () => {
      // A second organization used only by the member, so the two organizations share no user.
      const otherOrg = `${orgId}-other`;
      await prisma.llmUsage.create({ data: row({ organizationId: otherOrg, userId: memberId, feature: "f-x", inputTokens: 10, totalTokens: 10, createdAt: new Date(now - DAY) }) });
      try {
        const ids = (list: { id: string }[]) => list.map((x) => x.id);
        const all = (await get("/llm-usage/people").expect(200)).body;
        expect(ids(all.users)).to.include.members([namedUserId, goneUserId, memberId]);
        expect(ids(all.organizations)).to.include.members([orgId, otherOrg]);

        // Choose an organization: only the users with usage in it, and the organization list is not emptied.
        const inOrg = (await get(`/llm-usage/people?organizationId=${orgId}`).expect(200)).body;
        expect(ids(inOrg.users)).to.have.members([namedUserId, goneUserId]);
        expect(ids(inOrg.users)).to.not.include(memberId);
        expect(ids(inOrg.organizations)).to.include.members([orgId, otherOrg]);
        const inOther = (await get(`/llm-usage/people?organizationId=${otherOrg}`).expect(200)).body;
        expect(ids(inOther.users)).to.deep.equal([memberId]);

        // Choose a user: only their organizations, and the user list is not emptied.
        const ofUser = (await get(`/llm-usage/people?userId=${namedUserId}`).expect(200)).body;
        expect(ids(ofUser.organizations)).to.deep.equal([orgId]);
        expect(ids(ofUser.users)).to.include.members([namedUserId, memberId]);
        const ofMember = (await get(`/llm-usage/people?userId=${memberId}`).expect(200)).body;
        expect(ids(ofMember.organizations)).to.deep.equal([otherOrg]);

        // The "none" options follow the other filter too: no row in this organization lacks a user.
        expect(inOrg.hasNoUser).to.equal(false);
        expect((await get("/llm-usage/people").expect(200)).body.hasNoUser).to.equal(true);
      } finally {
        await prisma.llmUsage.deleteMany({ where: { organizationId: otherOrg } });
      }
    });

    it("is for admins only, and refuses a bad range", async () => {
      await request(app).get("/api/admin/llm-usage/people").expect(401);
      await get("/llm-usage/people", memberId).expect(403);
      await get("/llm-usage/people?from=2026-10-11&to=2026-10-01").expect(400);
      await get("/llm-usage/people?caseId=x").expect(400);
    });

    it("filters to the rows that name no user, or no organization", async () => {
      const noUser = (await get(`/llm-usage/summary?userId=none&feature=${noneFeature}`).expect(200)).body.totals;
      expect(noUser).to.deep.include({ calls: 1, tokens: 7 });
      const noOrg = (await get(`/llm-usage?organizationId=none&feature=${noneFeature}`).expect(200)).body;
      expect(noOrg.total).to.equal(1);
      expect(noOrg.rows[0]).to.include({ feature: noneFeature, userName: null, organizationName: null });
      // The seeded rows all name an organization, so "none" must not match them.
      const seededWithNone = (await get(`/llm-usage/summary?organizationId=none&feature=f-a`).expect(200)).body.totals;
      expect(seededWithNone.calls).to.equal(0);
    });

    it("filters the per-day numbers the same way", async () => {
      const { body } = await get(`/llm-usage/summary?userId=none&feature=${noneFeature}`).expect(200);
      expect(body.byDay).to.have.length(1);
      expect(body.byDay[0]).to.include({ calls: 1, tokens: 7 });
    });
  });

  describe("GET /llm-usage", () => {
    it("returns the page envelope, newest first, with names resolved", async () => {
      const { body } = await get(`/llm-usage?organizationId=${orgId}`).expect(200);
      expect(body).to.deep.include({ total: 3, page: 1, pageSize: 25, totalPages: 1 });
      // C is the newest; A and B share a timestamp day, so only their membership is asserted.
      expect(body.rows[0].feature).to.equal("f-c");
      expect(body.rows.map((r: any) => r.feature).sort()).to.deep.equal(["f-a", "f-b", "f-c"]);
      expect(body.rows[0]).to.include({ provider: "TYPESAFE", model: "jev-1", userName: null });
      const a = body.rows.find((r: any) => r.feature === "f-a");
      expect(a).to.include({ userName: "Named Person", model: "gpt-5.6-luna", cachedInputTokens: 400, estimatedCostUsd: 0.5 });
      const b = body.rows.find((r: any) => r.feature === "f-b");
      expect(b).to.include({ source: "ESTIMATED", model: null, estimatedCostUsd: null, passCount: 3, via: "chat-wonder" });
    });

    it("paginates", async () => {
      const first = (await get(`/llm-usage?organizationId=${orgId}&limit=2`).expect(200)).body;
      const second = (await get(`/llm-usage?organizationId=${orgId}&limit=2&page=2`).expect(200)).body;
      expect(first).to.deep.include({ total: 3, page: 1, pageSize: 2, totalPages: 2 });
      expect(first.rows).to.have.length(2);
      expect(second.rows).to.have.length(1);
      expect([...first.rows, ...second.rows].map((r: any) => r.id)).to.have.length(new Set([...first.rows, ...second.rows].map((r: any) => r.id)).size);
    });

    it("applies filters and refuses a page size above the cap", async () => {
      expect((await get(`/llm-usage?organizationId=${orgId}&source=ESTIMATED`).expect(200)).body.total).to.equal(1);
      expect((await get(`/llm-usage?organizationId=${orgId}&provider=TYPESAFE`).expect(200)).body.total).to.equal(1);
      await get("/llm-usage?limit=101").expect(400);
    });
  });
});
