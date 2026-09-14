import { expect } from "chai";
import request from "supertest";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { after, afterEach, before, describe, it } from "mocha";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import { ACCESS_TOKEN_SECRET } from "../src/config";
import { getLawSourceProvider } from "../src/legal/law-source/law-source.registry";

function tokenFor(userId: string) {
  return jwt.sign({ userId }, ACCESS_TOKEN_SECRET, { expiresIn: "1h" });
}

/** A single JSON-RPC tools/call response, structuredContent form. */
function mcpResponse(structuredContent: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const SLUG = "uksc/2099/1";
const CASE_URL = `https://caselaw.nationalarchives.gov.uk/${SLUG}`;

const caseLawSearchResult = {
  results: [
    {
      uri: SLUG,
      title: "UK Test Appellant v UK Test Respondent",
      court: "United Kingdom Supreme Court",
      published: "2099-01-15T00:00:00Z",
      updated: "2099-01-15T00:00:00Z",
      identifiers: [{ type: "ukncn", value: "[2099] UKSC 1", slug: SLUG }],
      xml_url: `${CASE_URL}/data.xml`,
      pdf_url: `${CASE_URL}/data.pdf`,
    },
  ],
  page: 1,
  has_more: false,
};

describe("UK Library source (LawSourceProvider)", () => {
  const ukUser = crypto.randomUUID();
  const ukOrgId = crypto.randomUUID();
  const realFetch = globalThis.fetch;

  function stubFetch(handler: () => Promise<Response> | Response) {
    globalThis.fetch = (async () => handler()) as typeof fetch;
  }

  before(async () => {
    const ukTenant = await prisma.tenant.upsert({
      where: { code: "UK" },
      update: {},
      create: { code: "UK", name: "United Kingdom" },
    });
    await prisma.user.create({
      data: { id: ukUser, email: `uk-src-${ukUser}@example.com`, username: `uk-src-${ukUser}` },
    });
    await prisma.organization.create({
      data: {
        id: ukOrgId,
        name: "UK Law Source Org",
        slug: `uk-src-${ukOrgId}`,
        tenantId: ukTenant.id,
        createdById: ukUser,
        members: { create: { userId: ukUser, role: "OWNER" } },
      },
    });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  after(async () => {
    globalThis.fetch = realFetch;
    const row = await prisma.law.findUnique({ where: { jurisSourceId: CASE_URL } });
    if (row) await prisma.citationEdge.deleteMany({ where: { fromLawId: row.id } });
    await prisma.law.deleteMany({ where: { jurisSourceId: CASE_URL } });
    await prisma.lawBrowsePage.deleteMany({ where: { filterKey: { contains: "t=UK" } } });
    await prisma.organizationMember.deleteMany({ where: { userId: ukUser } });
    await prisma.organization.deleteMany({ where: { id: ukOrgId } });
    await prisma.user.deleteMany({ where: { id: ukUser } });
  });

  it("dispatches to the UK provider by tenantCode and 501s an unmapped one", () => {
    expect(getLawSourceProvider("UK").tenantCode).to.equal("UK");
    expect(() => getLawSourceProvider("XX" as never)).to.throw(/coming soon/i);
  });

  it("search: MCP miss -> writes a UK-tenant Law row through and returns source uk-legal-mcp", async () => {
    stubFetch(() => mcpResponse(caseLawSearchResult));

    const res = await request(app)
      .get("/api/law/search?category=uk-case-law&q=uk-test-nonce")
      .set("Authorization", `Bearer ${tokenFor(ukUser)}`)
      .set("X-Organization-Id", ukOrgId);

    expect(res.status).to.equal(200);
    expect(res.body.meta.source).to.equal("uk-legal-mcp");
    expect(res.body.items[0].case_number).to.equal("[2099] UKSC 1");
    expect(res.body.items[0].id).to.equal(res.body.items[0].stored_id);

    const row = await prisma.law.findUnique({ where: { jurisSourceId: CASE_URL } });
    expect(row).to.not.be.null;
    expect(row!.category).to.equal("JURISPRUDENCE");
    expect(row!.division).to.equal("UKSC");
    const ukTenant = await prisma.tenant.findUnique({ where: { code: "UK" } });
    expect(row!.tenantId).to.equal(ukTenant!.id);
  });

  it("search: follow-up is served from the local DB with no MCP call", async () => {
    stubFetch(() => {
      throw new Error("MCP must not be reached on a local hit");
    });

    const res = await request(app)
      .get("/api/law/search?category=uk-case-law&q=UK Test Appellant")
      .set("Authorization", `Bearer ${tokenFor(ukUser)}`)
      .set("X-Organization-Id", ukOrgId);

    expect(res.status).to.equal(200);
    expect(res.body.meta.source).to.equal("cache");
    expect(res.body.items.map((i: { id: string }) => i.id)).to.include(
      (await prisma.law.findUnique({ where: { jurisSourceId: CASE_URL } }))!.id,
    );
  });

  it("document: fills lazy detail from the MCP, then serves it from cache", async () => {
    const lawId = (await prisma.law.findUnique({ where: { jurisSourceId: CASE_URL } }))!.id;
    await prisma.law.update({ where: { id: lawId }, data: { detailFetchedAt: null } });

    let calls = 0;
    stubFetch(() => {
      calls += 1;
      // judgment_get_index and citations_network fire in parallel; both stubs are harmless
      // to each other since the provider maps by shape.
      return mcpResponse({
        paragraphs: [{ eId: "para_1", preview: "1. Introduction" }],
        neutral_citations: ["[2000] UKSC 9"],
        law_report_refs: [],
        legislation_refs: ["Data Protection Act 2018"],
        si_refs: [],
        eu_refs: [],
        total_citations: 2,
      });
    });

    const first = await request(app)
      .get(`/api/law/document?category=uk-case-law&id=${lawId}`)
      .set("Authorization", `Bearer ${tokenFor(ukUser)}`)
      .set("X-Organization-Id", ukOrgId);

    expect(first.status).to.equal(200);
    expect(first.body.detail.fetched).to.equal(true);
    expect(first.body.source).to.equal("uk-legal-mcp");
    expect(calls).to.be.greaterThan(0);

    stubFetch(() => {
      throw new Error("MCP must not be reached once detail is stored");
    });
    const second = await request(app)
      .get(`/api/law/document?category=uk-case-law&id=${lawId}`)
      .set("Authorization", `Bearer ${tokenFor(ukUser)}`)
      .set("X-Organization-Id", ukOrgId);

    expect(second.status).to.equal(200);
    expect(second.body.source).to.equal("cache");
  });

  it("search: MCP unavailable + nothing stored -> 502", async () => {
    stubFetch(() => new Response("upstream boom", { status: 503 }));

    const res = await request(app)
      .get("/api/law/search?category=uk-legislation&q=totally-unstored-query-xyz")
      .set("Authorization", `Bearer ${tokenFor(ukUser)}`)
      .set("X-Organization-Id", ukOrgId);

    expect(res.status).to.equal(502);
  });

  it("browse: rejects uk-legislation with 400 (no query-less list upstream)", async () => {
    const res = await request(app)
      .get("/api/law/browse?category=uk-legislation")
      .set("Authorization", `Bearer ${tokenFor(ukUser)}`)
      .set("X-Organization-Id", ukOrgId);

    expect(res.status).to.equal(400);
  });

  it("citations/expand: UK runs citations_network inline and returns DONE with edges", async () => {
    const lawId = (await prisma.law.findUnique({ where: { jurisSourceId: CASE_URL } }))!.id;
    await prisma.citationEdge.deleteMany({ where: { fromLawId: lawId } });
    await prisma.law.update({ where: { id: lawId }, data: { citationsExtractedAt: null } });

    // One stub serves both citations_network (reads *_refs / neutral_citations) and
    // citations_resolve (reads resolved_url) — the unresolved path is enough for the contract.
    stubFetch(() =>
      mcpResponse({
        neutral_citations: ["[2000] UKSC 9"],
        law_report_refs: [],
        legislation_refs: [],
        si_refs: [],
        eu_refs: [],
        total_citations: 1,
        raw: "[2000] UKSC 9",
        type: "case",
        resolved_url: null,
        confidence: 0,
      }),
    );

    const res = await request(app)
      .post(`/api/law/${lawId}/citations/expand`)
      .set("Authorization", `Bearer ${tokenFor(ukUser)}`)
      .set("X-Organization-Id", ukOrgId);

    expect(res.status).to.equal(200);
    expect(res.body.status).to.equal("DONE");
    expect(res.body.edges).to.be.an("array").with.length(1);
    expect(res.body.edges[0].citationType).to.equal("case");
    expect(res.body.edges[0].toRawReference).to.equal("[2000] UKSC 9");
  });

  it("pdf proxy: streams a legislation PDF from our origin without X-Frame-Options, no auth", async () => {
    // seed a UK legislation row
    const legUrl = "https://www.legislation.gov.uk/ukpga/2018/12";
    await prisma.law.deleteMany({ where: { jurisSourceId: legUrl } });
    const ukTenant = await prisma.tenant.findUnique({ where: { code: "UK" } });
    const leg = await prisma.law.create({
      data: {
        jurisSourceId: legUrl,
        category: "REPUBLIC_ACT",
        tenantId: ukTenant!.id,
        title: "Data Protection Act 2018",
        jurisUrl: legUrl,
        rawJson: {},
      },
    });

    const pdfBytes = Buffer.from("%PDF-1.4\n%mock\n");
    stubFetch(
      () =>
        new Response(pdfBytes, { status: 200, headers: { "content-type": "application/pdf" } }),
    );

    const res = await request(app).get(`/api/law/${leg.id}/pdf`); // no Authorization header

    expect(res.status).to.equal(200);
    expect(res.headers["content-type"]).to.match(/application\/pdf/);
    expect(res.headers["x-frame-options"]).to.be.undefined;
    expect(res.headers["cross-origin-resource-policy"]).to.equal("cross-origin");

    stubFetch(() => new Response("<html>waf challenge</html>", { status: 202, headers: { "content-type": "text/html" } }));
    const blocked = await request(app).get(`/api/law/${leg.id}/pdf`);
    expect(blocked.status).to.equal(502);

    await prisma.law.deleteMany({ where: { id: leg.id } });
  });

  it("browse: uk-case-law paginates via an opaque cursor and caches the page", async () => {
    stubFetch(() => mcpResponse({ ...caseLawSearchResult, has_more: true }));

    const res = await request(app)
      .get("/api/law/browse?category=uk-case-law&court=uksc")
      .set("Authorization", `Bearer ${tokenFor(ukUser)}`)
      .set("X-Organization-Id", ukOrgId);

    expect(res.status).to.equal(200);
    expect(res.body.meta.dataset).to.equal("uk-case-law");
    expect(res.body.cursor).to.be.a("string");

    const page = await prisma.lawBrowsePage.findFirst({ where: { filterKey: { contains: "t=UK" } } });
    expect(page).to.not.be.null;
  });

  it("browse: an unknown court is rejected by validation with 400 (never reaches the MCP)", async () => {
    stubFetch(() => {
      throw new Error("MCP must not be called for an invalid court");
    });
    const res = await request(app)
      .get("/api/law/browse?category=uk-case-law&court=nica")
      .set("Authorization", `Bearer ${tokenFor(ukUser)}`)
      .set("X-Organization-Id", ukOrgId);
    expect(res.status).to.equal(400);
  });

  it("browse: an MCP tool error (isError + non-JSON text) surfaces cleanly, not as a 500", async () => {
    // Mirrors the real payload for a court TNA's atom feed rejects — `result.isError: true` and
    // `content[0].text` = "Internal error: {json}" (NOT parseable JSON).
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              isError: true,
              content: [
                {
                  type: "text",
                  text: 'Internal error: {"error_category": "validation", "description": "Upstream rejected the request (400)"}',
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const res = await request(app)
      // a court not touched by the other browse tests, so this misses the LawBrowsePage cache
      .get("/api/law/browse?category=uk-case-law&court=ewhc%2Fch")
      .set("Authorization", `Bearer ${tokenFor(ukUser)}`)
      .set("X-Organization-Id", ukOrgId);

    expect(res.status).to.be.oneOf([400, 502]);
    expect(res.status).to.not.equal(500);
  });
});
