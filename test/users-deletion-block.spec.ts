/** Deleting a client account while a lawyer request is open (UsersSvc.requestDeletion, DeletionBlockSvc):
 * DELETE /api/users/me answers 409 OPEN_LAWYER_REQUESTS for every blocking status and goes through for
 * CLOSED, EXPIRED and WITHDRAWN. Lawyer accounts are unchanged, and a Google account still deletes
 * without a password. Through the real routes against the real database; the emails are not sent. */
import crypto from "crypto";
import bcrypt from "bcrypt";
import { expect } from "chai";
import { describe, it, before, after, beforeEach, afterEach } from "mocha";
import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import { ACCESS_TOKEN_SECRET } from "../src/config";
import ClientCaseSvc from "../src/services/client-case.service";
import { DELETION_BLOCKING_REQUEST_STATUSES } from "../src/constants/client-request.constants";
import * as mailerModule from "../src/utils/mailer";

const tokenFor = (userId: string) => jwt.sign({ userId }, ACCESS_TOKEN_SECRET, { expiresIn: "1h" });
const NON_BLOCKING = ["CLOSED", "EXPIRED", "WITHDRAWN"] as const;

describe("Deleting a client account with lawyer requests", () => {
  const clientId = crypto.randomUUID();
  const googleId = crypto.randomUUID();
  const passwordId = crypto.randomUUID();
  const lawyerId = crypto.randomUUID();
  const ids = [clientId, googleId, passwordId, lawyerId];
  const caseIds: Record<string, string> = {};
  const caseTitle = `Deletion block ${crypto.randomUUID().slice(0, 6)}`;
  let savedSendEmail: unknown;

  const del = (userId: string, body: object = {}) => request(app).delete("/api/users/me").set({ Authorization: `Bearer ${tokenFor(userId)}` }).send(body);

  async function caseFor(userId: string, name: string) {
    const workspace = await ClientCaseSvc.workspaceFor(userId, name);
    const row = await prisma.case.create({ data: { userId, organizationId: workspace.id, caseName: caseTitle } });
    caseIds[userId] = row.id;
    return row.id;
  }
  const requestIn = (userId: string, status: string) =>
    prisma.clientRequest.create({ data: { caseId: caseIds[userId], clientId: userId, consentVersion: "test", consentAcceptedAt: new Date(), status: status as any } });
  const scheduled = async (userId: string) => !!(await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { deletionRequestedAt: true } })).deletionRequestedAt;

  before(async () => {
    const password = await bcrypt.hash("Sup3r-secret!", 4);
    await prisma.user.createMany({
      data: [
        { id: clientId, email: `del-client-${clientId}@example.com`, username: `del-client-${clientId}`, role: "USER" },
        { id: googleId, email: `del-google-${googleId}@example.com`, username: `del-google-${googleId}`, role: "USER", provider: "google", password },
        { id: passwordId, email: `del-pass-${passwordId}@example.com`, username: `del-pass-${passwordId}`, role: "USER", password },
        { id: lawyerId, email: `del-lawyer-${lawyerId}@example.com`, username: `del-lawyer-${lawyerId}`, role: "LAWYER" },
      ],
    });
    await caseFor(clientId, "Del Client");
    await caseFor(googleId, "Del Google");
    await caseFor(passwordId, "Del Password");
    const lawyerOrg = await prisma.organization.create({
      data: { name: "Del Lawyer Org", slug: `del-lawyer-${lawyerId}`, createdById: lawyerId, tenantId: (await prisma.tenant.findUniqueOrThrow({ where: { code: "UK" } })).id },
    });
    caseIds[lawyerId] = (await prisma.case.create({ data: { userId: lawyerId, organizationId: lawyerOrg.id, caseName: caseTitle } })).id;
  });

  after(async () => {
    await prisma.clientRequest.deleteMany({ where: { clientId: { in: ids } } });
    await prisma.case.deleteMany({ where: { id: { in: Object.values(caseIds) } } });
    await prisma.organization.deleteMany({ where: { createdById: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });

  beforeEach(() => {
    savedSendEmail = (mailerModule as any).sendEmail;
    (mailerModule as any).sendEmail = async () => "sent";
  });
  afterEach(async () => {
    (mailerModule as any).sendEmail = savedSendEmail;
    await prisma.clientRequest.deleteMany({ where: { clientId: { in: ids } } });
    await prisma.user.updateMany({ where: { id: { in: ids } }, data: { deletionRequestedAt: null } });
  });

  for (const status of DELETION_BLOCKING_REQUEST_STATUSES) {
    it(`refuses while a request is ${status}, lists it, and schedules nothing`, async () => {
      const open = await requestIn(clientId, status);
      const res = await del(clientId).expect(409);
      expect(res.body.code).to.equal("OPEN_LAWYER_REQUESTS");
      expect(res.body.requests).to.have.length(1);
      expect(res.body.requests[0]).to.deep.include({
        id: open.id,
        caseId: caseIds[clientId],
        caseTitle,
        action: status === "ENGAGED" ? "END" : status === "CONFIRMED" ? "REVIEW" : "WITHDRAW",
      });
      expect(await scheduled(clientId)).to.equal(false);
    });
  }

  for (const status of NON_BLOCKING) {
    it(`goes ahead when the only request is ${status}`, async () => {
      await requestIn(clientId, status);
      await del(clientId).expect(200);
      expect(await scheduled(clientId)).to.equal(true);
    });
  }

  it("goes ahead with no requests at all, as before", async () => {
    await del(clientId).expect(200);
    expect(await scheduled(clientId)).to.equal(true);
  });

  it("lists every blocking request, and not the ones that ended", async () => {
    const routed = await requestIn(clientId, "ROUTED");
    const engaged = await requestIn(clientId, "ENGAGED");
    await requestIn(clientId, "CLOSED");
    const res = await del(clientId).expect(409);
    expect(res.body.requests.map((r: any) => r.id)).to.have.members([routed.id, engaged.id]);
  });

  it("goes ahead once the request has been withdrawn", async () => {
    const open = await requestIn(clientId, "ROUTED");
    await del(clientId).expect(409);
    await prisma.clientRequest.update({ where: { id: open.id }, data: { status: "WITHDRAWN", withdrawnAt: new Date() } });
    await del(clientId).expect(200);
  });

  it("checks the open requests before the password, so the client learns what to do first", async () => {
    await requestIn(passwordId, "ROUTED");
    const res = await del(passwordId).expect(409);
    expect(res.body.code).to.equal("OPEN_LAWYER_REQUESTS");
  });

  it("still asks a password account for its password once nothing blocks", async () => {
    await del(passwordId).expect(400);
    await del(passwordId, { password: "wrong" }).expect(400);
    await del(passwordId, { password: "Sup3r-secret!" }).expect(200);
  });

  it("lets a Google account delete without a password", async () => {
    await del(googleId).expect(200);
    expect(await scheduled(googleId)).to.equal(true);
  });

  it("doesn't check a lawyer account", async () => {
    await prisma.clientRequest.create({ data: { caseId: caseIds[lawyerId], clientId: lawyerId, consentVersion: "test", consentAcceptedAt: new Date(), status: "ROUTED" } });
    await del(lawyerId).expect(200);
    expect(await scheduled(lawyerId)).to.equal(true);
  });
});
