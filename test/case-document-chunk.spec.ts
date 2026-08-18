import { expect } from "chai";
import request from "supertest";
import crypto from "crypto";
import { describe, it, before, after } from "mocha";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import { CHAT_WONDER_API_KEY } from "../src/config";

describe("GET /api/v1/case-document/:caseDocumentId", () => {
  const userId = crypto.randomUUID();
  const organizationId = crypto.randomUUID();
  const caseDocumentId = crypto.randomUUID();
  const chunkIds = [crypto.randomUUID(), crypto.randomUUID()];

  before(async () => {
    await prisma.user.create({
      data: { id: userId, email: `test-${userId}@example.com`, username: `test-${userId}` },
    });
    await prisma.organization.create({
      data: { id: organizationId, name: "Test Org", slug: `test-org-${organizationId}` },
    });
    await prisma.document.create({
      data: { id: caseDocumentId, userId, organizationId, name: "Test Document" },
    });
    await prisma.$executeRaw`
      INSERT INTO "CaseDocumentChunk" (id, "caseDocumentId", "chunkIndex", "chunkText", "charCount", "createdAt")
      VALUES
        (${chunkIds[0]}, ${caseDocumentId}, 0, 'First chunk of text', 20, now()),
        (${chunkIds[1]}, ${caseDocumentId}, 1, 'Second chunk of text', 21, now())
    `;
  });

  after(async () => {
    await prisma.$executeRaw`DELETE FROM "CaseDocumentChunk" WHERE "caseDocumentId" = ${caseDocumentId}`;
    await prisma.document.delete({ where: { id: caseDocumentId } });
    // Cascades to the OrganizationMember row created implicitly if any test adds one.
    await prisma.organization.delete({ where: { id: organizationId } });
    await prisma.user.delete({ where: { id: userId } });
  });

  it("rejects requests with no api key", async () => {
    const res = await request(app).get(`/api/v1/case-document/${caseDocumentId}`);
    expect(res.status).to.equal(401);
  });

  it("rejects requests with a wrong api key", async () => {
    const res = await request(app).get(`/api/v1/case-document/${caseDocumentId}`).set("x-api-key", "wrong-key");
    expect(res.status).to.equal(401);
  });

  it("returns 404 for an unknown case document", async () => {
    const res = await request(app)
      .get(`/api/v1/case-document/${crypto.randomUUID()}`)
      .set("x-api-key", CHAT_WONDER_API_KEY);
    expect(res.status).to.equal(404);
  });

  it("returns chunks ordered by chunkIndex, plus document metadata", async () => {
    const res = await request(app).get(`/api/v1/case-document/${caseDocumentId}`).set("x-api-key", CHAT_WONDER_API_KEY);

    expect(res.status).to.equal(200);
    expect(res.body.caseDocumentId).to.equal(caseDocumentId);
    expect(res.body.name).to.equal("Test Document");
    expect(res.body.caseId).to.equal(null);
    expect(res.body.ragStatus).to.equal("PENDING");
    expect(res.body.chunks).to.have.length(2);
    expect(res.body.chunks[0].chunkIndex).to.equal(0);
    expect(res.body.chunks[0].chunkText).to.equal("First chunk of text");
    expect(res.body.chunks[1].chunkIndex).to.equal(1);
  });

  it("serves the second request from cache (same result, no fresh DB read needed)", async () => {
    const first = await request(app).get(`/api/v1/case-document/${caseDocumentId}`).set("x-api-key", CHAT_WONDER_API_KEY);
    const second = await request(app).get(`/api/v1/case-document/${caseDocumentId}`).set("x-api-key", CHAT_WONDER_API_KEY);

    expect(second.status).to.equal(200);
    expect(second.body).to.deep.equal(first.body);
  });
});
