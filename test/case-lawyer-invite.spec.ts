/** CaseLawyerInvite schema (client invites their own lawyer): a row round-trips with its PENDING
 * default, and the token is unique. Against the real database; the fixture user and case are removed
 * afterwards. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after } from "mocha";
import prisma from "../src/lib/prisma";

describe("CaseLawyerInvite", function () {
  this.timeout(20_000);
  const clientId = crypto.randomUUID();
  const caseId = crypto.randomUUID();
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  before(async () => {
    await prisma.user.create({ data: { id: clientId, email: `invite-${clientId}@example.com`, username: `invite-${clientId}` } });
    await prisma.case.create({ data: { id: caseId, userId: clientId, caseName: "Invite test", caseAreas: ["EMPLOYMENT"], ukJurisdiction: "England and Wales" } });
  });

  after(async () => {
    await prisma.caseLawyerInvite.deleteMany({ where: { caseId } });
    await prisma.case.deleteMany({ where: { id: caseId } });
    await prisma.user.deleteMany({ where: { id: clientId } });
  });

  it("creates and reads back a CaseLawyerInvite with a unique token", async () => {
    const token = `tok-${crypto.randomUUID()}`;
    const invite = await prisma.caseLawyerInvite.create({ data: { caseId, clientId, token, expiresAt: future } });
    expect(invite.status).to.equal("PENDING");

    const read = await prisma.caseLawyerInvite.findUniqueOrThrow({ where: { id: invite.id } });
    expect(read.token).to.equal(token);
    expect(read.acceptedById).to.equal(null);

    let duplicateError: unknown;
    try {
      await prisma.caseLawyerInvite.create({ data: { caseId, clientId, token, expiresAt: future } });
    } catch (err) {
      duplicateError = err;
    }
    expect((duplicateError as { code?: string } | undefined)?.code).to.equal("P2002");
  });
});
