import { expect } from "chai";
import request from "supertest";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { after, before, describe, it } from "mocha";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import { ACCESS_TOKEN_SECRET } from "../src/config";

function tokenFor(userId: string) {
  return jwt.sign({ userId }, ACCESS_TOKEN_SECRET, { expiresIn: "1h" });
}

const JURIS_ID = "test-app-" + crypto.randomUUID();
const jurisPayload = (query: string) => ({
  items: [
    {
      id: JURIS_ID,
      score: 0.7,
      case_number: "G.R. No. 123456",
      case_title: "APP PETITIONER vs. APP RESPONDENT",
      year: 2025,
      facts: "Synthetic facts for the app law-search integration test.",
      tags: ["Test"],
      url: `https://juris.ph/case/${JURIS_ID}`,
    },
  ],
  meta: { dataset: "jurisprudence", query, year: null, limit: 5, count: 1 },
  notice: "juris.ph disclaimer.",
});

describe("GET /api/law/search (app-facing, tenant-gated)", () => {
  const phUser = crypto.randomUUID();
  const ukUser = crypto.randomUUID();
  const phOrgId = crypto.randomUUID();
  const ukOrgId = crypto.randomUUID();
  const realFetch = globalThis.fetch;

  before(async () => {
    const phTenant = await prisma.tenant.upsert({
      where: { code: "PH" },
      update: {},
      create: { code: "PH", name: "Philippines" },
    });
    const ukTenant = await prisma.tenant.upsert({
      where: { code: "UK" },
      update: {},
      create: { code: "UK", name: "United Kingdom" },
    });

    await prisma.user.create({ data: { id: phUser, email: `law-ph-${phUser}@example.com`, username: `law-ph-${phUser}` } });
    await prisma.user.create({ data: { id: ukUser, email: `law-uk-${ukUser}@example.com`, username: `law-uk-${ukUser}` } });

    await prisma.organization.create({
      data: {
        id: phOrgId,
        name: "Law Search PH Org",
        slug: `law-ph-${phOrgId}`,
        tenantId: phTenant.id,
        createdById: phUser,
        members: { create: { userId: phUser, role: "OWNER" } },
      },
    });
    await prisma.organization.create({
      data: {
        id: ukOrgId,
        name: "Law Search UK Org",
        slug: `law-uk-${ukOrgId}`,
        tenantId: ukTenant.id,
        createdById: ukUser,
        members: { create: { userId: ukUser, role: "OWNER" } },
      },
    });
  });

  after(async () => {
    globalThis.fetch = realFetch;
    await prisma.law.deleteMany({ where: { jurisSourceId: JURIS_ID } });
    await prisma.organizationMember.deleteMany({ where: { userId: { in: [phUser, ukUser] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [phOrgId, ukOrgId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [phUser, ukUser] } } });
  });

  function stubFetch(handler: () => Promise<Response> | Response) {
    globalThis.fetch = (async () => handler()) as typeof fetch;
  }

  it("requires the X-Organization-Id header", async () => {
    const res = await request(app)
      .get("/api/law/search?category=jurisprudence&q=privacy")
      .set("Authorization", `Bearer ${tokenFor(phUser)}`);
    expect(res.status).to.equal(400);
  });

  it("runs the local-first search for a PH org and write-through-stores a juris.ph hit", async () => {
    stubFetch(() => new Response(JSON.stringify(jurisPayload("app-law-nonce")), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    const res = await request(app)
      .get("/api/law/search?category=jurisprudence&q=app-law-nonce")
      .set("Authorization", `Bearer ${tokenFor(phUser)}`)
      .set("X-Organization-Id", phOrgId);

    expect(res.status).to.equal(200);
    expect(res.body.meta.source).to.equal("juris.ph");
    expect(res.body.items[0].stored).to.equal(true);

    const row = await prisma.law.findUnique({ where: { jurisSourceId: JURIS_ID } });
    expect(row).to.not.be.null;
    expect(row!.category).to.equal("JURISPRUDENCE");
  });

  it("serves the stored row from the local DB on a follow-up PH search (no juris.ph call)", async () => {
    stubFetch(() => {
      throw new Error("ECONNREFUSED 127.0.0.1:443");
    });

    const res = await request(app)
      .get("/api/law/search?category=jurisprudence&q=synthetic")
      .set("Authorization", `Bearer ${tokenFor(phUser)}`)
      .set("X-Organization-Id", phOrgId);

    expect(res.status).to.equal(200);
    expect(res.body.meta.source).to.equal("cache");
    expect(res.body.items.map((i: { id: string }) => i.id)).to.include(JURIS_ID);
  });

  it("returns 501 (coming soon) for a UK org and never calls juris.ph", async () => {
    stubFetch(() => {
      throw new Error("juris.ph must not be reached for a non-PH tenant");
    });

    const res = await request(app)
      .get("/api/law/search?category=jurisprudence&q=privacy")
      .set("Authorization", `Bearer ${tokenFor(ukUser)}`)
      .set("X-Organization-Id", ukOrgId);

    expect(res.status).to.equal(501);
    expect(res.body).to.not.have.property("items");
  });
});

describe("GET /api/law/browse (facet browse, tenant-gated)", () => {
  const phUser = crypto.randomUUID();
  const ukUser = crypto.randomUUID();
  const phOrgId = crypto.randomUUID();
  const ukOrgId = crypto.randomUUID();
  const realFetch = globalThis.fetch;
  const pointIds = [crypto.randomUUID(), crypto.randomUUID()];

  // A Qdrant scroll page, shaped exactly like juris.ph's /api/qdrant/juris-decisions/scroll.
  const scrollPage = (ids: string[], year = 2025) => ({
    result: {
      points: ids.map((id, i) => ({
        id,
        payload: {
          case_number: `G.R. No. 99000${i}`,
          case_title: `BROWSE PETITIONER ${i} vs. BROWSE RESPONDENT`,
          case_type: "Criminal",
          year,
          tags: ["Criminal Law"],
          factual_background: "Synthetic browse facts.",
          final_disposition: "The petition is DENIED.",
          source_pdf_url: `https://juris-assets.example/${id}.pdf`,
          source_url: `https://lawphil.example/${id}.html`,
        },
      })),
      next_page_offset: null,
    },
    status: "ok",
    time: 0.01,
  });

  before(async () => {
    // Browse pages are cached (LawBrowsePage) keyed by filter+cursor — clear the ones these
    // tests use so a re-run doesn't get a cache hit where it expects a live juris.ph fetch.
    await prisma.lawBrowsePage.deleteMany({ where: { filterKey: { contains: "d=jurisprudence" } } });

    const phTenant = await prisma.tenant.upsert({ where: { code: "PH" }, update: {}, create: { code: "PH", name: "Philippines" } });
    const ukTenant = await prisma.tenant.upsert({ where: { code: "UK" }, update: {}, create: { code: "UK", name: "United Kingdom" } });

    await prisma.user.create({ data: { id: phUser, email: `law-br-ph-${phUser}@example.com`, username: `law-br-ph-${phUser}` } });
    await prisma.user.create({ data: { id: ukUser, email: `law-br-uk-${ukUser}@example.com`, username: `law-br-uk-${ukUser}` } });

    await prisma.organization.create({
      data: { id: phOrgId, name: "Law Browse PH", slug: `law-br-ph-${phOrgId}`, tenantId: phTenant.id, createdById: phUser, members: { create: { userId: phUser, role: "OWNER" } } },
    });
    await prisma.organization.create({
      data: { id: ukOrgId, name: "Law Browse UK", slug: `law-br-uk-${ukOrgId}`, tenantId: ukTenant.id, createdById: ukUser, members: { create: { userId: ukUser, role: "OWNER" } } },
    });
  });

  after(async () => {
    globalThis.fetch = realFetch;
    await prisma.lawBrowsePage.deleteMany({ where: { filterKey: { contains: "d=jurisprudence" } } });
    await prisma.law.deleteMany({ where: { jurisSourceId: { in: pointIds } } });
    await prisma.organizationMember.deleteMany({ where: { userId: { in: [phUser, ukUser] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [phOrgId, ukOrgId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [phUser, ukUser] } } });
  });

  function stubFetch(handler: () => Promise<Response> | Response) {
    globalThis.fetch = (async () => handler()) as typeof fetch;
  }

  it("normalizes a juris.ph scroll page, writes it through, and reports no next page for a short page", async () => {
    stubFetch(() => new Response(JSON.stringify(scrollPage(pointIds)), { status: 200, headers: { "content-type": "application/json" } }));

    const res = await request(app)
      .get("/api/law/browse?category=jurisprudence&caseType=Criminal&limit=20")
      .set("Authorization", `Bearer ${tokenFor(phUser)}`)
      .set("X-Organization-Id", phOrgId);

    expect(res.status).to.equal(200);
    expect(res.body.items).to.have.length(2);
    expect(res.body.items[0].case_title).to.match(/BROWSE PETITIONER/);
    expect(res.body.items[0].url).to.equal(`https://juris.ph/case/${pointIds[0]}`);
    expect(res.body.items[0].stored).to.equal(true);
    expect(res.body.meta.hasMore).to.equal(false); // 2 < limit 20
    expect(res.body.cursor).to.equal(null);

    const rows = await prisma.law.findMany({ where: { jurisSourceId: { in: pointIds } } });
    expect(rows).to.have.length(2);
    expect(rows[0].category).to.equal("JURISPRUDENCE");
  });

  it("hands back an opaque cursor when the page is full", async () => {
    const fullIds = Array.from({ length: 20 }, () => crypto.randomUUID());
    pointIds.push(...fullIds);
    stubFetch(() => new Response(JSON.stringify(scrollPage(fullIds, 2020)), { status: 200, headers: { "content-type": "application/json" } }));

    const res = await request(app)
      .get("/api/law/browse?category=jurisprudence&limit=20")
      .set("Authorization", `Bearer ${tokenFor(phUser)}`)
      .set("X-Organization-Id", phOrgId);

    expect(res.status).to.equal(200);
    expect(res.body.meta.hasMore).to.equal(true);
    expect(res.body.cursor).to.be.a("string").and.not.empty;
    const decoded = JSON.parse(Buffer.from(res.body.cursor, "base64url").toString());
    expect(decoded.lastYear).to.equal(2020);
    expect(decoded.seenIds).to.have.length(20);
  });

  it("serves the same browse page from cache on a repeat request (no juris.ph call)", async () => {
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    pointIds.push(...ids);
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify(scrollPage(ids, 2019)), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const url = "/api/law/browse?category=jurisprudence&year=2019&limit=20";
    const first = await request(app).get(url).set("Authorization", `Bearer ${tokenFor(phUser)}`).set("X-Organization-Id", phOrgId);
    expect(first.status).to.equal(200);
    expect(calls).to.equal(1);
    expect(first.body.items[0].stored).to.equal(true);

    const second = await request(app).get(url).set("Authorization", `Bearer ${tokenFor(phUser)}`).set("X-Organization-Id", phOrgId);
    expect(second.status).to.equal(200);
    expect(calls).to.equal(1); // no new fetch — served from LawBrowsePage
    expect(second.body.items).to.have.length(2);
    expect(second.body.items[0].stored).to.equal(false);
    expect(second.body.items[0].case_title).to.match(/BROWSE PETITIONER 0/);
  });

  it("rejects an unknown topic", async () => {
    const res = await request(app)
      .get("/api/law/browse?category=jurisprudence&topics=criminal,notatopic")
      .set("Authorization", `Bearer ${tokenFor(phUser)}`)
      .set("X-Organization-Id", phOrgId);
    expect(res.status).to.equal(400);
  });

  it("returns 501 for a UK org and never calls juris.ph", async () => {
    stubFetch(() => {
      throw new Error("juris.ph must not be reached for a non-PH tenant");
    });

    const res = await request(app)
      .get("/api/law/browse?category=jurisprudence")
      .set("Authorization", `Bearer ${tokenFor(ukUser)}`)
      .set("X-Organization-Id", ukOrgId);

    expect(res.status).to.equal(501);
  });
});

describe("GET /api/law/document (detail, local-first with detail)", () => {
  const phUser = crypto.randomUUID();
  const ukUser = crypto.randomUUID();
  const phOrgId = crypto.randomUUID();
  const ukOrgId = crypto.randomUUID();
  const realFetch = globalThis.fetch;
  const raId = crypto.randomUUID();

  const retrievePayload = () => ({
    result: [
      {
        id: raId,
        payload: {
          ra_bill_number: "12345",
          title: "An Act For The Document Detail Test",
          year: 2024,
          summary: "Synthetic RA summary.",
          tags: ["Test"],
          sections: [{ title: "Section 1.", summary: "Does a thing." }],
          key_provisions: ["Provision A", "Provision B"],
          keywords: ["alpha", "beta"],
          date_enacted: "March 3, 2024",
          affected_laws_amendments: "RA 1 (amended)",
        },
      },
    ],
    status: "ok",
    time: 0.01,
  });

  before(async () => {
    const phTenant = await prisma.tenant.upsert({ where: { code: "PH" }, update: {}, create: { code: "PH", name: "Philippines" } });
    const ukTenant = await prisma.tenant.upsert({ where: { code: "UK" }, update: {}, create: { code: "UK", name: "United Kingdom" } });

    await prisma.user.create({ data: { id: phUser, email: `law-doc-ph-${phUser}@example.com`, username: `law-doc-ph-${phUser}` } });
    await prisma.user.create({ data: { id: ukUser, email: `law-doc-uk-${ukUser}@example.com`, username: `law-doc-uk-${ukUser}` } });

    await prisma.organization.create({
      data: { id: phOrgId, name: "Law Doc PH", slug: `law-doc-ph-${phOrgId}`, tenantId: phTenant.id, createdById: phUser, members: { create: { userId: phUser, role: "OWNER" } } },
    });
    await prisma.organization.create({
      data: { id: ukOrgId, name: "Law Doc UK", slug: `law-doc-uk-${ukOrgId}`, tenantId: ukTenant.id, createdById: ukUser, members: { create: { userId: ukUser, role: "OWNER" } } },
    });
  });

  after(async () => {
    globalThis.fetch = realFetch;
    await prisma.law.deleteMany({ where: { jurisSourceId: raId } });
    await prisma.organizationMember.deleteMany({ where: { userId: { in: [phUser, ukUser] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [phOrgId, ukOrgId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [phUser, ukUser] } } });
  });

  function stubFetch(handler: () => Promise<Response> | Response) {
    globalThis.fetch = (async () => handler()) as typeof fetch;
  }

  it("retrieves from juris.ph on a miss, stores the detail, and marks it fetched", async () => {
    stubFetch(() => new Response(JSON.stringify(retrievePayload()), { status: 200, headers: { "content-type": "application/json" } }));

    const res = await request(app)
      .get(`/api/law/document?category=republic-acts&id=${raId}`)
      .set("Authorization", `Bearer ${tokenFor(phUser)}`)
      .set("X-Organization-Id", phOrgId);

    expect(res.status).to.equal(200);
    expect(res.body.source).to.equal("juris.ph");
    expect(res.body.item.reference).to.equal("12345");
    expect(res.body.detail.fetched).to.equal(true);
    expect(res.body.detail.key_provisions).to.deep.equal(["Provision A", "Provision B"]);
    expect(res.body.detail.sections).to.have.length(1);

    const row = await prisma.law.findUnique({ where: { jurisSourceId: raId } });
    expect(row!.detailFetchedAt).to.not.be.null;
    expect(row!.keywords).to.deep.equal(["alpha", "beta"]);
  });

  it("serves the stored detail without calling juris.ph on the second request", async () => {
    stubFetch(() => {
      throw new Error("juris.ph must not be reached once detail is stored");
    });

    const res = await request(app)
      .get(`/api/law/document?category=republic-acts&id=${raId}`)
      .set("Authorization", `Bearer ${tokenFor(phUser)}`)
      .set("X-Organization-Id", phOrgId);

    expect(res.status).to.equal(200);
    expect(res.body.source).to.equal("cache");
    expect(res.body.detail.fetched).to.equal(true);
  });

  it("404s an id juris.ph doesn't know", async () => {
    stubFetch(() => new Response(JSON.stringify({ result: [], status: "ok", time: 0 }), { status: 200, headers: { "content-type": "application/json" } }));

    const res = await request(app)
      .get(`/api/law/document?category=republic-acts&id=${crypto.randomUUID()}`)
      .set("Authorization", `Bearer ${tokenFor(phUser)}`)
      .set("X-Organization-Id", phOrgId);

    expect(res.status).to.equal(404);
  });

  it("returns 501 for a UK org", async () => {
    const res = await request(app)
      .get(`/api/law/document?category=republic-acts&id=${raId}`)
      .set("Authorization", `Bearer ${tokenFor(ukUser)}`)
      .set("X-Organization-Id", ukOrgId);
    expect(res.status).to.equal(501);
  });
});
