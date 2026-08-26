import { expect } from "chai";
import request from "supertest";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { describe, it, before, after } from "mocha";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import { ACCESS_TOKEN_SECRET } from "../src/config";
import CaseAccess from "../src/utils/case-access";

function tokenFor(userId: string) {
  return jwt.sign({ userId }, ACCESS_TOKEN_SECRET, { expiresIn: "1h" });
}

describe("Tenant + jurisdiction isolation across a PH org and a UK org", () => {
  const userA = crypto.randomUUID(); // member of orgA (PH)
  const userB = crypto.randomUUID(); // member of orgB (UK)
  const orgAId = crypto.randomUUID();
  const orgBId = crypto.randomUUID();
  const caseAId = crypto.randomUUID();
  const caseBId = crypto.randomUUID();

  before(async () => {
    await prisma.user.create({ data: { id: userA, email: `iso-a-${userA}@example.com`, username: `iso-a-${userA}` } });
    await prisma.user.create({ data: { id: userB, email: `iso-b-${userB}@example.com`, username: `iso-b-${userB}` } });

    await prisma.organization.create({
      data: {
        id: orgAId,
        name: "Isolation Org PH",
        slug: `iso-org-ph-${orgAId}`,
        jurisdiction: "PH",
        createdById: userA,
        members: { create: { userId: userA, role: "OWNER" } },
      },
    });
    await prisma.organization.create({
      data: {
        id: orgBId,
        name: "Isolation Org UK",
        slug: `iso-org-uk-${orgBId}`,
        jurisdiction: "UK",
        createdById: userB,
        members: { create: { userId: userB, role: "OWNER" } },
      },
    });

    await prisma.case.create({ data: { id: caseAId, userId: userA, organizationId: orgAId, caseName: "PH Case" } });
    await prisma.case.create({ data: { id: caseBId, userId: userB, organizationId: orgBId, caseName: "UK Case" } });
  });

  after(async () => {
    await prisma.proceduralDeadline.deleteMany({ where: { caseId: { in: [caseAId, caseBId] } } });
    await prisma.case.deleteMany({ where: { id: { in: [caseAId, caseBId] } } });
    await prisma.organizationMember.deleteMany({ where: { userId: { in: [userA, userB] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgAId, orgBId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userA, userB] } } });
  });

  it("resolves each case's jurisdiction from its own organization", async () => {
    expect(await CaseAccess.resolveJurisdiction(caseAId)).to.equal("PH");
    expect(await CaseAccess.resolveJurisdiction(caseBId)).to.equal("UK");
  });

  it("lets a member read their own org's case", async () => {
    const res = await request(app)
      .get(`/api/my-cases/${caseAId}/procedure`)
      .set("Authorization", `Bearer ${tokenFor(userA)}`)
      .set("X-Organization-Id", orgAId);
    expect(res.status).to.equal(200);
  });

  it("blocks a member of org B from reading org A's case, even with a valid org header of their own", async () => {
    const res = await request(app)
      .get(`/api/my-cases/${caseAId}/procedure`)
      .set("Authorization", `Bearer ${tokenFor(userB)}`)
      .set("X-Organization-Id", orgBId);
    expect(res.status).to.equal(404);
  });

  it("blocks a member of org B from creating a deadline on org A's case", async () => {
    const res = await request(app)
      .post(`/api/my-cases/${caseAId}/procedure/deadlines`)
      .set("Authorization", `Bearer ${tokenFor(userB)}`)
      .set("X-Organization-Id", orgBId)
      .send({ ruleCode: "answer_civil", triggerDate: "2026-01-05" });
    expect(res.status).to.equal(404);
  });

  it("computes a PH deadline for the PH org's case using PH rules", async () => {
    const res = await request(app)
      .post(`/api/my-cases/${caseAId}/procedure/deadlines`)
      .set("Authorization", `Bearer ${tokenFor(userA)}`)
      .set("X-Organization-Id", orgAId)
      .send({ ruleCode: "answer_civil", triggerDate: "2026-01-05" });
    expect(res.status).to.equal(201);
    expect(res.body.ruleSource).to.include("Rules of Civil Procedure");
  });

  it("computes a UK deadline for the UK org's case using UK rules, and rejects a PH rule code", async () => {
    const ukRes = await request(app)
      .post(`/api/my-cases/${caseBId}/procedure/deadlines`)
      .set("Authorization", `Bearer ${tokenFor(userB)}`)
      .set("X-Organization-Id", orgBId)
      .send({ ruleCode: "acknowledgment_of_service", triggerDate: "2026-01-05" });
    expect(ukRes.status).to.equal(201);
    expect(ukRes.body.ruleSource).to.include("LEGAL_REVIEW_REQUIRED");

    // A PH-only rule code must never silently resolve against the UK org's case.
    const wrongRes = await request(app)
      .post(`/api/my-cases/${caseBId}/procedure/deadlines`)
      .set("Authorization", `Bearer ${tokenFor(userB)}`)
      .set("X-Organization-Id", orgBId)
      .send({ ruleCode: "answer_civil", triggerDate: "2026-01-05" });
    expect(wrongRes.status).to.equal(400);
  });

  it("returns jurisdiction-scoped procedure rule catalogs from /api/terminal/procedure-rules", async () => {
    const phRes = await request(app)
      .get("/api/terminal/procedure-rules")
      .set("Authorization", `Bearer ${tokenFor(userA)}`)
      .set("X-Organization-Id", orgAId);
    expect(phRes.status).to.equal(200);
    expect(phRes.body.map((r: { code: string }) => r.code)).to.include("answer_civil");
    expect(phRes.body.map((r: { code: string }) => r.code)).to.not.include("acknowledgment_of_service");

    const ukRes = await request(app)
      .get("/api/terminal/procedure-rules")
      .set("Authorization", `Bearer ${tokenFor(userB)}`)
      .set("X-Organization-Id", orgBId);
    expect(ukRes.status).to.equal(200);
    expect(ukRes.body.map((r: { code: string }) => r.code)).to.include("acknowledgment_of_service");
    expect(ukRes.body.map((r: { code: string }) => r.code)).to.not.include("answer_civil");
  });

  it("never rejects a PH legal-rag request as unavailable, but always rejects a UK one (no PH fallback)", async () => {
    // The `documents` corpus lives outside Prisma's schema (external ingestion pipeline — see
    // legal-rag.repository.ts), so its presence in a given test DB isn't guaranteed. What must
    // always hold regardless of environment: PH is never turned away as "unavailable" (501),
    // and UK never is anything else — it must never silently see PH corpus data.
    const phRes = await request(app)
      .get("/api/legal-rag/categories")
      .set("Authorization", `Bearer ${tokenFor(userA)}`)
      .set("X-Organization-Id", orgAId);
    expect(phRes.status).to.not.equal(501);

    const ukRes = await request(app)
      .get("/api/legal-rag/categories")
      .set("Authorization", `Bearer ${tokenFor(userB)}`)
      .set("X-Organization-Id", orgBId);
    expect(ukRes.status).to.equal(501);
    expect(ukRes.body).to.not.have.property("categories");
  });

  it("rejects UK library-sections/search requests instead of returning PH corpus data", async () => {
    const ukSections = await request(app)
      .get("/api/legal-rag/library-sections")
      .set("Authorization", `Bearer ${tokenFor(userB)}`)
      .set("X-Organization-Id", orgBId);
    expect(ukSections.status).to.equal(501);

    const ukSearch = await request(app)
      .get("/api/legal/search?q=contract")
      .set("Authorization", `Bearer ${tokenFor(userB)}`)
      .set("X-Organization-Id", orgBId);
    expect(ukSearch.status).to.equal(501);
  });
});
