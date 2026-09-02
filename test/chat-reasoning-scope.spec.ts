import { expect } from "chai";
import crypto from "crypto";
import { describe, it, before, after } from "mocha";
import prisma from "../src/lib/prisma";
import ChatRepo from "../src/repositories/chat.repository";
import ChatSvc from "../src/services/chat.service";
import HttpError from "../src/utils/http-error";

describe("SCL reasoning trace, scoped by consultationId or caseId", () => {
  const userId = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  const otherOrgId = crypto.randomUUID();
  const caseAId = crypto.randomUUID();
  const caseBId = crypto.randomUUID();
  // Two consultations under case A, one under case B — proves case-scoped lookup
  // spans every consultation linked to the case, not just the first one.
  const consultA1Id = crypto.randomUUID();
  const consultA2Id = crypto.randomUUID();
  const consultBId = crypto.randomUUID();

  const messageIds = {
    a1: crypto.randomUUID(),
    a2: crypto.randomUUID(),
    b: crypto.randomUUID(),
  };

  before(async () => {
    await prisma.user.create({ data: { id: userId, email: `scl-${userId}@example.com`, username: `scl-${userId}` } });

    await prisma.organization.create({
      data: { id: orgId, name: "SCL Trace Org", slug: `scl-org-${orgId}`, createdById: userId },
    });
    await prisma.organization.create({
      data: { id: otherOrgId, name: "SCL Trace Other Org", slug: `scl-other-org-${otherOrgId}`, createdById: userId },
    });

    await prisma.case.createMany({
      data: [
        { id: caseAId, userId, organizationId: orgId, caseName: "SCL Case A" },
        { id: caseBId, userId, organizationId: orgId, caseName: "SCL Case B" },
      ],
    });

    await prisma.consultation.createMany({
      data: [
        { id: consultA1Id, organizationId: orgId, userId, title: "A1", caseId: caseAId },
        { id: consultA2Id, organizationId: orgId, userId, title: "A2", caseId: caseAId },
        { id: consultBId, organizationId: orgId, userId, title: "B", caseId: caseBId },
      ],
    });

    await prisma.message.createMany({
      data: [
        { id: messageIds.a1, consultationId: consultA1Id, role: "assistant", content: "answer A1" },
        { id: messageIds.a2, consultationId: consultA2Id, role: "assistant", content: "answer A2" },
        { id: messageIds.b, consultationId: consultBId, role: "assistant", content: "answer B" },
      ],
    });

    await prisma.messageReasoning.createMany({
      data: [
        { messageId: messageIds.a1, reasoning: "reasoning A1", citationReasons: [] },
        { messageId: messageIds.a2, reasoning: "reasoning A2", citationReasons: [] },
        { messageId: messageIds.b, reasoning: "reasoning B", citationReasons: [] },
      ],
    });
  });

  after(async () => {
    await prisma.messageReasoning.deleteMany({ where: { messageId: { in: Object.values(messageIds) } } });
    await prisma.message.deleteMany({ where: { id: { in: Object.values(messageIds) } } });
    await prisma.consultation.deleteMany({ where: { id: { in: [consultA1Id, consultA2Id, consultBId] } } });
    await prisma.case.deleteMany({ where: { id: { in: [caseAId, caseBId] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  describe("ChatRepo", () => {
    it("listReasoningByConsultation returns only that consultation's reasoning", async () => {
      const rows = await ChatRepo.listReasoningByConsultation(consultA1Id);
      expect(rows.map((r) => r.messageId)).to.deep.equal([messageIds.a1]);
    });

    it("listReasoningByCase spans every consultation under the case, not just one", async () => {
      const rows = await ChatRepo.listReasoningByCase(caseAId);
      expect(rows.map((r) => r.messageId).sort()).to.deep.equal([messageIds.a1, messageIds.a2].sort());
    });

    it("listReasoningByCase excludes a sibling case's consultation", async () => {
      const rows = await ChatRepo.listReasoningByCase(caseBId);
      expect(rows.map((r) => r.messageId)).to.deep.equal([messageIds.b]);
    });
  });

  describe("ChatSvc.listReasoning", () => {
    it("filters by consultationId when the org owns it", async () => {
      const rows = await ChatSvc.listReasoning(orgId, consultA1Id, undefined);
      expect(rows.map((r) => r.messageId)).to.deep.equal([messageIds.a1]);
    });

    it("filters by caseId across multiple consultations when the org owns it", async () => {
      const rows = await ChatSvc.listReasoning(orgId, undefined, caseAId);
      expect(rows.map((r) => r.messageId).sort()).to.deep.equal([messageIds.a1, messageIds.a2].sort());
    });

    it("404s when a different org asks for this consultationId", async () => {
      try {
        await ChatSvc.listReasoning(otherOrgId, consultA1Id, undefined);
        expect.fail("expected HttpError to be thrown");
      } catch (e) {
        expect(e).to.be.instanceOf(HttpError);
        expect((e as HttpError).statusCode).to.equal(404);
      }
    });

    it("404s when a different org asks for this caseId", async () => {
      try {
        await ChatSvc.listReasoning(otherOrgId, undefined, caseAId);
        expect.fail("expected HttpError to be thrown");
      } catch (e) {
        expect(e).to.be.instanceOf(HttpError);
        expect((e as HttpError).statusCode).to.equal(404);
      }
    });
  });
});
