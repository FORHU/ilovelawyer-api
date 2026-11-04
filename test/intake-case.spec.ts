import { expect } from "chai";
import request from "supertest";
import crypto from "crypto";
import { describe, it, before, after } from "mocha";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import { CHAT_WONDER_API_KEY } from "../src/config";
import ClientCaseSvc from "../src/services/client-case.service";

async function seedClient(createdUserIds: string[], role: "USER" | "LAWYER" = "USER") {
  const userId = crypto.randomUUID();
  await prisma.user.create({
    data: { id: userId, role, email: `intake-${userId}@example.com`, username: `intake-${userId}`, name: "Sam Client" },
  });
  createdUserIds.push(userId);
  return userId;
}

// Seeds the case directly (rather than through ClientCaseSvc.create) to skip that path's regional
// pricing lookup, which this test's workspace isn't set up for.
async function seedCase(userId: string) {
  const workspace = await ClientCaseSvc.workspaceFor(userId, "Sam Client");
  const row = await prisma.case.create({
    data: {
      id: crypto.randomUUID(),
      userId,
      organizationId: workspace.id,
      caseName: "Placeholder case",
      caseAreas: ["EMPLOYMENT"],
      ukJurisdiction: "England and Wales",
      status: "ACTIVE",
    },
  });
  return row.id;
}

describe("PATCH /api/v1/intake-cases/:caseId", () => {
  const createdUserIds: string[] = [];

  after(async () => {
    await prisma.case.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.organizationMember.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.organization.deleteMany({ where: { createdById: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  });

  it("writes the real case details chat-wonder's create_case tool drafted", async () => {
    const userId = await seedClient(createdUserIds);
    const caseId = await seedCase(userId);

    const res = await request(app)
      .patch(`/api/v1/intake-cases/${caseId}`)
      .set("x-api-key", CHAT_WONDER_API_KEY)
      .send({
        userId,
        title: "Dismissed after whistleblowing disclosure",
        areas: ["EMPLOYMENT"],
        ukJurisdiction: "England and Wales",
        side: "CLAIMANT",
        notes: "Raised a concern about safety, dismissed two weeks later.",
      });

    expect(res.status).to.equal(200);
    expect(res.body.title).to.equal("Dismissed after whistleblowing disclosure");
    expect(res.body.side).to.equal("CLAIMANT");
  });

  it("rejects a userId that belongs to a lawyer account, not a client", async () => {
    const lawyerId = await seedClient(createdUserIds, "LAWYER");
    const userId = await seedClient(createdUserIds);
    const caseId = await seedCase(userId);

    const res = await request(app)
      .patch(`/api/v1/intake-cases/${caseId}`)
      .set("x-api-key", CHAT_WONDER_API_KEY)
      .send({ userId: lawyerId, title: "x" });

    expect(res.status).to.equal(403);
  });

  it("rejects a caseId that belongs to a different user's workspace", async () => {
    const userId = await seedClient(createdUserIds);
    await seedCase(userId);
    const otherUserId = await seedClient(createdUserIds);
    const otherCaseId = await seedCase(otherUserId);

    const res = await request(app)
      .patch(`/api/v1/intake-cases/${otherCaseId}`)
      .set("x-api-key", CHAT_WONDER_API_KEY)
      .send({ userId, title: "x" });

    expect(res.status).to.equal(404);
  });

  it("rejects a missing or wrong x-api-key", async () => {
    const userId = await seedClient(createdUserIds);
    const caseId = await seedCase(userId);

    const noKey = await request(app)
      .patch(`/api/v1/intake-cases/${caseId}`)
      .send({ userId, title: "x" });
    expect(noKey.status).to.equal(401);

    const wrongKey = await request(app)
      .patch(`/api/v1/intake-cases/${caseId}`)
      .set("x-api-key", "wrong-key")
      .send({ userId, title: "x" });
    expect(wrongKey.status).to.equal(401);
  });

  it("accepts setting clientSide on a case with none yet, without erroring", async () => {
    const userId = await seedClient(createdUserIds);
    const caseId = await seedCase(userId);

    const res = await request(app)
      .patch(`/api/v1/intake-cases/${caseId}`)
      .set("x-api-key", CHAT_WONDER_API_KEY)
      .send({ userId, side: "CLAIMANT" });

    expect(res.status).to.equal(200);
    expect(res.body.side).to.equal("CLAIMANT");
  });

  it("rejects the legacy singular area field instead of silently ignoring it", async () => {
    const userId = await seedClient(createdUserIds);
    const caseId = await seedCase(userId);

    const res = await request(app)
      .patch(`/api/v1/intake-cases/${caseId}`)
      .set("x-api-key", CHAT_WONDER_API_KEY)
      .send({ userId, area: "EMPLOYMENT" });

    expect(res.status).to.equal(400);
  });

  it("rejects a body with no real case-detail field, even though userId alone would satisfy min(1)", async () => {
    const userId = await seedClient(createdUserIds);
    const caseId = await seedCase(userId);

    const res = await request(app)
      .patch(`/api/v1/intake-cases/${caseId}`)
      .set("x-api-key", CHAT_WONDER_API_KEY)
      .send({ userId });

    expect(res.status).to.equal(400);
  });

  it("leaves every other field untouched on a partial payload", async () => {
    const userId = await seedClient(createdUserIds);
    const caseId = await seedCase(userId);

    const res = await request(app)
      .patch(`/api/v1/intake-cases/${caseId}`)
      .set("x-api-key", CHAT_WONDER_API_KEY)
      .send({ userId, title: "New title" });

    expect(res.status).to.equal(200);
    expect(res.body.title).to.equal("New title");
    expect(res.body.areas.map((a: { code: string }) => a.code)).to.deep.equal(["EMPLOYMENT"]);
    expect(res.body.ukJurisdiction).to.equal("England and Wales");
  });
});
