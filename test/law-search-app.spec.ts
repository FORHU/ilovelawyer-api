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
