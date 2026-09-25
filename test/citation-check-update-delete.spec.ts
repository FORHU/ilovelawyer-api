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

describe("Citation check — update and delete", () => {
  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  const orgAId = crypto.randomUUID();
  const orgBId = crypto.randomUUID();
  const caseAId = crypto.randomUUID();
  const caseBId = crypto.randomUUID();

  const asA = (req: request.Test) => req.set("Authorization", `Bearer ${tokenFor(userA)}`).set("X-Organization-Id", orgAId);
  const asB = (req: request.Test) => req.set("Authorization", `Bearer ${tokenFor(userB)}`).set("X-Organization-Id", orgBId);

  const createCitation = async (body: Record<string, unknown>) => {
    const res = await asA(request(app).post(`/api/my-cases/${caseAId}/citations`)).send(body);
    expect(res.status).to.equal(201);
    return res.body as { id: string };
  };

  before(async () => {
    await prisma.user.create({ data: { id: userA, email: `cite-upd-a-${userA}@example.com`, username: `cite-upd-a-${userA}` } });
    await prisma.user.create({ data: { id: userB, email: `cite-upd-b-${userB}@example.com`, username: `cite-upd-b-${userB}` } });

    const phTenant = await prisma.tenant.upsert({ where: { code: "PH" }, update: {}, create: { code: "PH", name: "Philippines" } });

    for (const [orgId, userId, label] of [
      [orgAId, userA, "a"],
      [orgBId, userB, "b"],
    ] as const) {
      await prisma.organization.create({
        data: {
          id: orgId,
          name: `Citation Edit Org ${label}`,
          slug: `cite-edit-org-${label}-${orgId}`,
          tenantId: phTenant.id,
          createdById: userId,
          members: { create: { userId, role: "OWNER" } },
        },
      });
    }

    await prisma.case.create({ data: { id: caseAId, userId: userA, organizationId: orgAId, caseName: "Citation Edit Case A" } });
    await prisma.case.create({ data: { id: caseBId, userId: userB, organizationId: orgBId, caseName: "Citation Edit Case B" } });
  });

  after(async () => {
    await prisma.citationCheck.deleteMany({ where: { caseId: { in: [caseAId, caseBId] } } });
    await prisma.case.deleteMany({ where: { id: { in: [caseAId, caseBId] } } });
    await prisma.organizationMember.deleteMany({ where: { userId: { in: [userA, userB] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgAId, orgBId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userA, userB] } } });
  });

  it("edits a citation and re-verifies it against the new text", async () => {
    const created = await createCitation({
      quotedText: "the buyer must pay the price",
      officialText: "the buyer must pay the price on delivery",
    });

    const res = await asA(request(app).patch(`/api/my-cases/${caseAId}/citations/${created.id}`)).send({
      quotedText: "a quotation the source never contains",
      officialText: "",
      pinpoint: "para. 4",
    });

    expect(res.status).to.equal(200);
    expect(res.body.quotedText).to.equal("a quotation the source never contains");
    expect(res.body.officialText).to.equal(null);
    expect(res.body.pinpoint).to.equal("para. 4");
    // Emptied source text means there is nothing to verify against, so it can't stay VALID.
    expect(res.body.status).to.equal("UNVERIFIED");

    const stored = await prisma.citationCheck.findUnique({ where: { id: created.id } });
    expect(stored?.quotedText).to.equal("a quotation the source never contains");
    expect(stored?.status).to.equal("UNVERIFIED");
  });

  it("keeps fields that the edit leaves out", async () => {
    const created = await createCitation({
      quotedText: "possession is nine-tenths of the law",
      officialText: "possession is nine-tenths of the law, as the saying goes",
    });

    const res = await asA(request(app).patch(`/api/my-cases/${caseAId}/citations/${created.id}`)).send({ pinpoint: "p. 15" });

    expect(res.status).to.equal(200);
    expect(res.body.quotedText).to.equal("possession is nine-tenths of the law");
    expect(res.body.officialText).to.equal("possession is nine-tenths of the law, as the saying goes");
    expect(res.body.status).to.equal("VALID");
  });

  it("rejects an empty edit and an emptied quote", async () => {
    const created = await createCitation({ quotedText: "some quoted text", officialText: "some quoted text and more" });
    const url = `/api/my-cases/${caseAId}/citations/${created.id}`;

    expect((await asA(request(app).patch(url)).send({})).status).to.equal(400);
    expect((await asA(request(app).patch(url)).send({ quotedText: "" })).status).to.equal(400);
  });

  it("deletes a citation, and it no longer appears in the case's citations", async () => {
    const created = await createCitation({ quotedText: "delete me", officialText: "delete me please" });

    const res = await asA(request(app).delete(`/api/my-cases/${caseAId}/citations/${created.id}`));
    expect(res.status).to.equal(204);

    const list = await asA(request(app).get(`/api/my-cases/${caseAId}/citations`));
    expect(list.status).to.equal(200);
    expect((list.body as { id: string }[]).some((c) => c.id === created.id)).to.equal(false);

    const again = await asA(request(app).delete(`/api/my-cases/${caseAId}/citations/${created.id}`));
    expect(again.status).to.equal(404);
  });

  it("cannot edit or delete another case's citation", async () => {
    const created = await createCitation({ quotedText: "belongs to case A", officialText: "belongs to case A entirely" });

    // User B owns case B: naming case A's citation id under case B must not reach it.
    const patchRes = await asB(request(app).patch(`/api/my-cases/${caseBId}/citations/${created.id}`)).send({
      quotedText: "hijacked",
    });
    expect(patchRes.status).to.equal(404);
    const deleteRes = await asB(request(app).delete(`/api/my-cases/${caseBId}/citations/${created.id}`));
    expect(deleteRes.status).to.equal(404);

    const stored = await prisma.citationCheck.findUnique({ where: { id: created.id } });
    expect(stored?.quotedText).to.equal("belongs to case A");
  });
});
