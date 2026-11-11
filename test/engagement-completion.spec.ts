/** Engagement Completion end to end, through the real routes against the real database: the lawyer
 * says the work is finished and the engagement waits on the client, who confirms it (it closes, the
 * lawyer's access ends and the earning's hold starts) or says what's left (the lawyer carries on and
 * can ask again). Unanswered, it closes by itself after 7 days. The client can still end it, and the
 * lawyer can still find they can't continue, meanwhile. Payments go through the dummy provider. Each
 * test acts only on its own request: never the sweep over the whole database. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after, beforeEach, afterEach } from "mocha";
import request from "supertest";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import { givePracticeArea } from "./support/practice-area-fixture";
import loginToken from "../src/utils/loginToken";
import SecurityAuditRepo from "../src/repositories/security-audit.repository";
import EngagementCompletionSvc from "../src/services/engagement-completion.service";
import * as mailerModule from "../src/utils/mailer";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe("engagement completion", function () {
  this.timeout(20_000);
  const lawyerId = crypto.randomUUID();
  const clientId = crypto.randomUUID();
  const otherClientId = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  const clientOrgId = crypto.randomUUID();
  const caseId = crypto.randomUUID();
  let requestId: string;

  const auth = (id: string) => ({ Authorization: `Bearer ${loginToken(id, false).accessToken}` });
  const asLawyer = { ...auth(lawyerId), "X-Organization-Id": orgId };
  const asGuest = { ...auth(lawyerId), "X-Organization-Id": clientOrgId };
  const inDays = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString();
  const FIXED_FEE = { type: "FIXED_FEE", amount: { amountMinor: 60000, currency: "GBP" }, message: "I can take this on for a fixed fee.", expiresAt: inDays(5) };

  const close = (body: object) => request(app).post(`/api/client-requests/${requestId}/close`).set(asLawyer).send(body);
  const finished = (note?: string) => close({ outcome: "WORK_FINISHED", ...(note ? { note } : {}) });
  const confirm = (as = clientId) => request(app).post(`/api/client/lawyer-requests/${requestId}/completion/confirm`).set(auth(as)).send({});
  const decline = (body: object, as = clientId) => request(app).post(`/api/client/lawyer-requests/${requestId}/completion/decline`).set(auth(as)).send(body);
  const end = () => request(app).post(`/api/client/lawyer-requests/${requestId}/end`).set(auth(clientId)).send({});
  const lawyerView = () => request(app).get(`/api/client-requests/${requestId}`).set(asLawyer);
  const clientView = () => request(app).get(`/api/client/lawyer-requests/${requestId}`).set(auth(clientId));
  const row = () => prisma.clientRequest.findUniqueOrThrow({ where: { id: requestId } });
  const earning = () => prisma.earning.findFirstOrThrow({ where: { requestId } });
  const hasAccess = async () => !!(await prisma.caseAccess.findUnique({ where: { caseId_userId: { caseId, userId: lawyerId } } }));
  const bells = async (userId: string) => (await prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: "asc" } })).map((n) => n.title);
  /** The ask as if it was made `days` ago. */
  const askedDaysAgo = (days: number) => prisma.clientRequest.update({ where: { id: requestId }, data: { completionRequestedAt: new Date(Date.now() - days * DAY_MS) } });

  let audits: { action: string; actorId?: string | null; payload?: Record<string, unknown> }[];
  let emails: { to: string; subject: string; text?: string }[];
  const repo = SecurityAuditRepo as unknown as { create: (data: object) => Promise<object> };
  const realCreate = repo.create;
  const realSendEmail = mailerModule.sendEmail;

  before(async () => {
    const tenant = await prisma.tenant.upsert({ where: { code: "UK" }, update: {}, create: { code: "UK", name: "United Kingdom" } });
    const user = (id: string, name: string, role: "LAWYER" | "USER") => ({ id, email: `done-${id}@example.com`, username: `done-${id}`, name, role, tenantId: tenant.id });
    await prisma.user.createMany({ data: [user(lawyerId, "Lena Lawyer", "LAWYER"), user(clientId, "Clara Client", "USER"), user(otherClientId, "Otto Other", "USER")] });
    await prisma.organization.create({
      data: { id: orgId, name: "Lena Law LLP", slug: `done-${orgId}`, tenantId: tenant.id, createdById: lawyerId, members: { create: [{ userId: lawyerId, role: "OWNER", status: "ACCEPTED" }] } },
    });
    await prisma.organization.create({
      data: { id: clientOrgId, name: "Clara Client", slug: `done-${clientOrgId}`, tenantId: tenant.id, createdById: clientId, isPersonal: true, members: { create: { userId: clientId, role: "OWNER", status: "ACCEPTED" } } },
    });
    await prisma.lawyerClientProfile.create({ data: { userId: lawyerId, acceptingRequests: true, verificationStatus: "VERIFIED", verifiedAt: new Date() } });
    await prisma.lawyerUkRegistration.create({ data: { userId: lawyerId, regulator: "SRA", registrationNumber: "9731", qualifiedJurisdictions: ["England and Wales"] } });
    await givePracticeArea([lawyerId]);
    await prisma.case.create({ data: { id: caseId, userId: clientId, organizationId: clientOrgId, caseName: "Unfair dismissal", caseAreas: ["EMPLOYMENT"], ukJurisdiction: "England and Wales" } });
  });

  const cleanWallet = async () => {
    const w = await prisma.wallet.findUnique({ where: { ownerType_ownerId: { ownerType: "ORGANIZATION", ownerId: orgId } } });
    if (!w) return;
    await prisma.walletLedgerEntry.deleteMany({ where: { walletId: w.id } });
    await prisma.earning.deleteMany({ where: { walletId: w.id } });
    await prisma.wallet.delete({ where: { id: w.id } });
  };
  const cleanRequests = async () => {
    await prisma.lawyerExit.deleteMany({ where: { caseId } });
    await prisma.quotationPayment.deleteMany({ where: { clientId } });
    await prisma.clientRequest.deleteMany({ where: { caseId } });
    await prisma.caseAccess.deleteMany({ where: { caseId } });
    await prisma.notification.deleteMany({ where: { userId: { in: [lawyerId, clientId] } } });
  };

  after(async () => {
    await cleanWallet();
    await cleanRequests();
    await prisma.auditEvent.deleteMany({ where: { caseId } });
    await prisma.case.deleteMany({ where: { id: caseId } });
    await prisma.lawyerUkRegistration.deleteMany({ where: { userId: lawyerId } });
    await prisma.lawyerClientProfile.deleteMany({ where: { userId: lawyerId } });
    await prisma.organizationMember.deleteMany({ where: { userId: { in: [lawyerId, clientId] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgId, clientOrgId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [lawyerId, clientId, otherClientId] } } });
  });

  beforeEach(async () => {
    await cleanWallet();
    await cleanRequests();
    const now = new Date();
    const created = await prisma.clientRequest.create({
      data: { caseId, clientId, consentVersion: "test", consentAcceptedAt: now, status: "ROUTED", routedAt: now, routingExpiresAt: new Date(now.getTime() + 48 * HOUR_MS) },
    });
    requestId = created.id;
    await prisma.clientRequestClaim.create({ data: { requestId, lawyerId, organizationId: orgId, claimedAt: now, expiresAt: new Date(now.getTime() + 24 * HOUR_MS) } });
    // Quoted, accepted and paid: ENGAGED.
    await request(app).put(`/api/client-requests/${requestId}/quotation`).set(asLawyer).send(FIXED_FEE).expect(200);
    const quotationId = (await request(app).post(`/api/client-requests/${requestId}/quotation/send`).set(asLawyer).expect(200)).body.quotation.id;
    await request(app).post(`/api/client/lawyer-requests/${requestId}/quotations/${quotationId}/accept`).set(auth(clientId)).send({ disclosureAcknowledged: true }).expect(200);
    await request(app).post(`/api/client/lawyer-requests/${requestId}/quotations/${quotationId}/payment`).set(auth(clientId)).send({}).expect(200);
    await prisma.notification.deleteMany({ where: { userId: { in: [lawyerId, clientId] } } });

    audits = [];
    emails = [];
    repo.create = async (data: object) => {
      audits.push(data as (typeof audits)[number]);
      return realCreate(data);
    };
    (mailerModule as unknown as { sendEmail: unknown }).sendEmail = async (mail: { to: string; subject: string; text?: string }) => {
      emails.push(mail);
      return "sent";
    };
  });

  afterEach(() => {
    repo.create = realCreate;
    (mailerModule as unknown as { sendEmail: unknown }).sendEmail = realSendEmail;
  });

  describe("the lawyer says the work is finished", () => {
    it("doesn't close it: it waits on the client, and the lawyer keeps their access", async () => {
      const body = (await finished("Your settlement agreement is signed.").expect(200)).body;
      expect(body.status).to.equal("ENGAGED");
      expect(body.engagement.closedAt).to.equal(null);
      expect(body.engagement.completion).to.deep.include({ note: "Your settlement agreement is signed.", declinedAt: null, confirmedBy: null });
      expect(new Date(body.engagement.completion.autoClosesAt).getTime()).to.be.closeTo(Date.now() + 7 * DAY_MS, 60_000);
      expect(await hasAccess()).to.equal(true);
      await request(app).get(`/api/my-cases/${caseId}`).set(asGuest).expect(200);
      expect((await earning()).availableAt).to.equal(null);
      expect(audits.map((a) => a.action)).to.not.include("client_request.closed");
    });

    it("shows the client the ask, and tells them by bell and email with the lawyer's note", async () => {
      await finished("Your settlement agreement is signed.").expect(200);
      const view = (await clientView().expect(200)).body;
      expect(view.status).to.equal("ENGAGED");
      expect(view.completion).to.deep.include({ note: "Your settlement agreement is signed." });
      expect(view.completion.requestedAt).to.be.a("string");
      expect(await bells(clientId)).to.deep.equal(["Lena Lawyer says the work on your case is finished"]);
      expect(emails).to.have.length(1);
      expect(emails[0]).to.deep.include({ to: `done-${clientId}@example.com`, subject: "Lena Lawyer says the work on your case is finished" });
      expect(emails[0]!.text).to.include("Your settlement agreement is signed.");
      const feed = await prisma.auditEvent.findMany({ where: { caseId, action: "client_request.completion_requested" } });
      expect(feed.map((e) => (e.payload as { requestId: string }).requestId)).to.include(requestId);
    });

    it("can't be said twice while it waits", async () => {
      await finished().expect(200);
      expect((await finished().expect(409)).body.code).to.equal("COMPLETION_PENDING");
    });
  });

  describe("the client confirms", () => {
    it("closes it as the lawyer's close: access ends and the earning's hold starts", async () => {
      await finished().expect(200);
      const body = (await confirm().expect(200)).body;
      expect(body).to.deep.include({ status: "CLOSED", closedBy: "LAWYER" });
      expect(body.completion).to.deep.include({ confirmedBy: "CLIENT", autoClosesAt: null });
      expect(await hasAccess()).to.equal(false);
      expect((await earning()).availableAt!.getTime()).to.be.closeTo(Date.now() + 7 * DAY_MS, 60_000);
      expect((await row()).completionConfirmedBy).to.equal("CLIENT");
      const closed = audits.find((a) => a.action === "client_request.closed")!;
      expect(closed.actorId).to.equal(clientId);
      expect(closed.payload).to.deep.include({ outcome: "WORK_FINISHED", confirmedBy: "CLIENT" });
      expect(await bells(lawyerId)).to.include("The client confirmed the work is finished");
      expect((await lawyerView().expect(200)).body.engagement.completion).to.deep.include({ confirmedBy: "CLIENT" });
    });

    it("lets the client rate the lawyer once it's closed", async () => {
      await finished().expect(200);
      await confirm().expect(200);
      await request(app).post(`/api/client/lawyer-requests/${requestId}/feedback`).set(auth(clientId)).send({ rating: 5 }).expect(201);
    });

    it("has nothing to confirm before the lawyer asks, or once it's closed", async () => {
      expect((await confirm().expect(409)).body.code).to.equal("COMPLETION_NOT_REQUESTED");
      await finished().expect(200);
      await confirm().expect(200);
      expect((await confirm().expect(409)).body.code).to.equal("INVALID_REQUEST_STATUS");
    });

    it("is the client's own request only", async () => {
      await finished().expect(200);
      await confirm(otherClientId).expect(404);
      await decline({ reason: "No." }, otherClientId).expect(404);
      expect((await row()).status).to.equal("ENGAGED");
    });
  });

  describe("the client says it isn't finished", () => {
    it("keeps it engaged, tells the lawyer what's left, and lets them ask again", async () => {
      await finished().expect(200);
      const body = (await decline({ reason: "You haven't sent the signed copy yet." }).expect(200)).body;
      expect(body.status).to.equal("ENGAGED");
      expect(body.completion).to.deep.include({ requestedAt: null, autoClosesAt: null, declineReason: "You haven't sent the signed copy yet." });
      expect(await hasAccess()).to.equal(true);
      const notes = await prisma.notification.findMany({ where: { userId: lawyerId } });
      expect(notes.map((n) => [n.title, n.message])).to.deep.include(["The client says the work isn't finished", "You haven't sent the signed copy yet."]);
      expect((await lawyerView().expect(200)).body.engagement.completion).to.deep.include({ declineReason: "You haven't sent the signed copy yet." });

      const again = (await finished("Signed copy sent.").expect(200)).body;
      expect(again.engagement.completion).to.deep.include({ note: "Signed copy sent.", declinedAt: null, declineReason: null });
    });

    it("needs a reason, and an ask to answer", async () => {
      expect((await decline({ reason: "Not yet." }).expect(409)).body.code).to.equal("COMPLETION_NOT_REQUESTED");
      await finished().expect(200);
      await decline({}).expect(400);
      await decline({ reason: "   " }).expect(400);
      expect((await row()).completionRequestedAt).to.not.equal(null);
    });

    it("an unanswered ask doesn't close by itself once the client has said it isn't finished", async () => {
      await finished().expect(200);
      await decline({ reason: "Not yet." }).expect(200);
      expect(await EngagementCompletionSvc.closeIfDue(requestId, new Date(Date.now() + 8 * DAY_MS))).to.equal(false);
      expect((await row()).status).to.equal("ENGAGED");
    });
  });

  describe("nobody answers", () => {
    it("closes by itself after 7 days, and tells both sides", async () => {
      await finished().expect(200);
      expect(await EngagementCompletionSvc.closeIfDue(requestId, new Date(Date.now() + 6 * DAY_MS))).to.equal(false);
      await askedDaysAgo(7.1);
      emails = [];
      expect(await EngagementCompletionSvc.closeIfDue(requestId, new Date())).to.equal(true);
      const r = await row();
      expect(r).to.deep.include({ status: "CLOSED", closedBy: "LAWYER", completionConfirmedBy: "AUTO" });
      expect(await hasAccess()).to.equal(false);
      expect((await earning()).availableAt).to.not.equal(null);
      expect(audits.find((a) => a.action === "client_request.closed")?.actorId).to.equal(null);
      expect(await bells(lawyerId)).to.include("Your engagement has closed");
      expect(emails.map((e) => e.subject)).to.deep.equal(["Your engagement with Lena Lawyer has closed"]);
      // Once only.
      expect(await EngagementCompletionSvc.closeIfDue(requestId, new Date())).to.equal(false);
    });
  });

  describe("meanwhile", () => {
    it("the client can still end it", async () => {
      await finished().expect(200);
      const body = (await end().expect(200)).body;
      expect(body).to.deep.include({ status: "CLOSED", closedBy: "CLIENT" });
      expect(body.completion.autoClosesAt).to.equal(null);
      await askedDaysAgo(8);
      expect(await EngagementCompletionSvc.closeIfDue(requestId, new Date())).to.equal(false);
      expect((await row()).completionConfirmedBy).to.equal(null);
    });

    it("the lawyer can still find they can't continue, which closes it at once", async () => {
      await finished().expect(200);
      const body = (await close({ outcome: "CANT_CONTINUE", reason: "CONFLICT", workDone: false }).expect(200)).body;
      expect(body.status).to.equal("CLOSED");
      expect(body.engagement.exit).to.not.equal(null);
      expect((await confirm().expect(409)).body.code).to.equal("INVALID_REQUEST_STATUS");
    });
  });
});
