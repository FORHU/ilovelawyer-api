import { expect } from "chai";
import request from "supertest";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { describe, it, before, after } from "mocha";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import { ACCESS_TOKEN_SECRET } from "../src/config";

function tokenFor(userId: string) {
  return jwt.sign({ userId }, ACCESS_TOKEN_SECRET, { expiresIn: "1h" });
}

describe("Citation check — jurisdiction guard on legalRagId", () => {
  const userA = crypto.randomUUID(); // member of orgA (PH)
  const userB = crypto.randomUUID(); // member of orgB (UK)
  const orgAId = crypto.randomUUID();
  const orgBId = crypto.randomUUID();
  const caseAId = crypto.randomUUID();
  const caseBId = crypto.randomUUID();

  before(async () => {
    await prisma.user.create({ data: { id: userA, email: `cite-a-${userA}@example.com`, username: `cite-a-${userA}` } });
    await prisma.user.create({ data: { id: userB, email: `cite-b-${userB}@example.com`, username: `cite-b-${userB}` } });

    await prisma.organization.create({
      data: {
        id: orgAId,
        name: "Citation Org PH",
        slug: `cite-org-ph-${orgAId}`,
        jurisdiction: "PH",
        createdById: userA,
        members: { create: { userId: userA, role: "OWNER" } },
      },
    });
    await prisma.organization.create({
      data: {
        id: orgBId,
        name: "Citation Org UK",
        slug: `cite-org-uk-${orgBId}`,
        jurisdiction: "UK",
        createdById: userB,
        members: { create: { userId: userB, role: "OWNER" } },
      },
    });

    await prisma.case.create({ data: { id: caseAId, userId: userA, organizationId: orgAId, caseName: "PH Citation Case" } });
    await prisma.case.create({ data: { id: caseBId, userId: userB, organizationId: orgBId, caseName: "UK Citation Case" } });
  });

  after(async () => {
    await prisma.citationCheck.deleteMany({ where: { caseId: { in: [caseAId, caseBId] } } });
    await prisma.case.deleteMany({ where: { id: { in: [caseAId, caseBId] } } });
    await prisma.organizationMember.deleteMany({ where: { userId: { in: [userA, userB] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgAId, orgBId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userA, userB] } } });
  });

  it("rejects a legalRagId citation check on a UK case instead of reading PH corpus text", async () => {
    const res = await request(app)
      .post(`/api/my-cases/${caseBId}/citations`)
      .set("Authorization", `Bearer ${tokenFor(userB)}`)
      .set("X-Organization-Id", orgBId)
      .send({ quotedText: "some quoted text", legalRagId: "1" });

    expect(res.status).to.equal(400);
  });

  it("still accepts an officialText-only citation check on a UK case (no corpus involved)", async () => {
    const res = await request(app)
      .post(`/api/my-cases/${caseBId}/citations`)
      .set("Authorization", `Bearer ${tokenFor(userB)}`)
      .set("X-Organization-Id", orgBId)
      .send({ quotedText: "some quoted text", officialText: "some quoted text and more" });

    expect(res.status).to.equal(201);
  });

  it("does not change existing PH behavior for a legalRagId citation check", async () => {
    const res = await request(app)
      .post(`/api/my-cases/${caseAId}/citations`)
      .set("Authorization", `Bearer ${tokenFor(userA)}`)
      .set("X-Organization-Id", orgAId)
      .send({ quotedText: "some quoted text", legalRagId: "999999999" });

    // Not 400 (the jurisdiction guard doesn't apply) — the id itself won't resolve to a real
    // document, so officialText simply stays null and evaluateCitation runs as before.
    expect(res.status).to.equal(201);
  });
});
