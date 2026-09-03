import { expect } from "chai";
import request from "supertest";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { after, before, describe, it } from "mocha";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import { ACCESS_TOKEN_SECRET } from "../src/config";

function adminToken(userId: string) {
  return jwt.sign({ userId }, ACCESS_TOKEN_SECRET, { expiresIn: "1h" });
}

// A single jurisprudence hit, shaped exactly like juris.ph's /search response.
const JURIS_ID = "test-" + crypto.randomUUID();
function jurisPayload(query: string, score = 0.5) {
  return {
    items: [
      {
        id: JURIS_ID,
        score,
        case_number: "G.R. No. 999999",
        case_title: "TEST PETITIONER vs. TEST RESPONDENT",
        case_type: "Special Proceeding",
        division: "First Division",
        ponente: "Justice Test",
        year: 2025,
        decision_date: "2025-01-15",
        facts: "Synthetic facts for the law-search integration test.",
        disposition: "The petition is DENIED.",
        tags: ["Test", "Integration"],
        legal_rules_cited: ["Rule 1, Test Rules"],
        url: `https://juris.ph/case/${JURIS_ID}`,
        pdf_url: "https://example.test/doc.pdf",
        source_url: "https://example.test/source.html",
      },
    ],
    meta: { dataset: "jurisprudence", query, year: null, limit: 5, count: 1 },
    notice: "juris.ph disclaimer.",
  };
}

/** A query string guaranteed not to match any stored Law row (forces the juris.ph path). */
const missQuery = () => "zzz-" + crypto.randomUUID();

describe("GET /api/admin/law/search", () => {
  const adminId = crypto.randomUUID();
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;

  before(async () => {
    await prisma.user.create({
      data: {
        id: adminId,
        email: `law-admin-${adminId}@example.com`,
        username: `law-admin-${adminId}`,
        role: "ADMIN",
      },
    });
    // Self-sufficient: guarantee the PH tenant exists regardless of seed state.
    await prisma.tenant.upsert({
      where: { code: "PH" },
      update: {},
      create: { code: "PH", name: "Philippines" },
    });
  });

  after(async () => {
    globalThis.fetch = realFetch;
    await prisma.law.deleteMany({ where: { jurisSourceId: JURIS_ID } });
    await prisma.user.deleteMany({ where: { id: adminId } });
  });

  function stubFetch(handler: () => Promise<Response> | Response) {
    fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return handler();
    }) as typeof fetch;
  }

  it("rejects an unknown category", async () => {
    const res = await request(app)
      .get("/api/admin/law/search?category=statutes&q=privacy")
      .set("Authorization", `Bearer ${adminToken(adminId)}`);
    expect(res.status).to.equal(400);
  });

  it("on a local miss, fetches juris.ph and stores the hit", async () => {
    const q = missQuery();
    stubFetch(() => new Response(JSON.stringify(jurisPayload(q)), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    const res = await request(app)
      .get(`/api/admin/law/search?category=jurisprudence&q=${q}`)
      .set("Authorization", `Bearer ${adminToken(adminId)}`);

    expect(res.status).to.equal(200);
    expect(fetchCalls).to.equal(1);
    expect(res.body.meta.source).to.equal("juris.ph");
    expect(res.body.items).to.have.length(1);
    expect(res.body.items[0].stored).to.equal(true);
    expect(res.body.items[0].stored_id).to.be.a("string").and.not.empty;

    const row = await prisma.law.findUnique({ where: { jurisSourceId: JURIS_ID } });
    expect(row).to.not.be.null;
    expect(row!.category).to.equal("JURISPRUDENCE");
    const phTenant = await prisma.tenant.findUnique({ where: { code: "PH" } });
    expect(row!.tenantId).to.equal(phTenant!.id);
  });

  it("serves a stored row from the local DB without calling juris.ph", async () => {
    // Even with juris.ph 'down', a local match must resolve.
    stubFetch(() => {
      throw new Error("ECONNREFUSED 127.0.0.1:443");
    });

    const res = await request(app)
      .get("/api/admin/law/search?category=jurisprudence&q=synthetic")
      .set("Authorization", `Bearer ${adminToken(adminId)}`);

    expect(res.status).to.equal(200);
    expect(fetchCalls).to.equal(0);
    expect(res.body.meta.source).to.equal("cache");
    const hit = res.body.items.find((i: { id: string }) => i.id === JURIS_ID);
    expect(hit).to.not.be.undefined;
    expect(hit.stored).to.equal(false);
    expect(hit.stored_id).to.be.a("string").and.not.empty;
  });

  it("dedupes when juris.ph returns a hit we already store: no new row, score refreshed", async () => {
    const q = missQuery(); // local miss -> juris.ph path, but JURIS_ID is already stored
    stubFetch(() => new Response(JSON.stringify(jurisPayload(q, 0.9)), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    const res = await request(app)
      .get(`/api/admin/law/search?category=jurisprudence&q=${q}`)
      .set("Authorization", `Bearer ${adminToken(adminId)}`);

    expect(res.status).to.equal(200);
    expect(res.body.items[0].stored).to.equal(false);

    const rows = await prisma.law.findMany({ where: { jurisSourceId: JURIS_ID } });
    expect(rows).to.have.length(1);
    expect(rows[0].score).to.equal(0.9);
  });

  it("502 when juris.ph is unavailable and nothing matches locally", async () => {
    stubFetch(() => {
      throw new Error("ECONNREFUSED 127.0.0.1:443");
    });

    const res = await request(app)
      .get(`/api/admin/law/search?category=jurisprudence&q=${missQuery()}`)
      .set("Authorization", `Bearer ${adminToken(adminId)}`);

    expect(res.status).to.equal(502);
  });
});
