/** Lawyer Exit (FORHU/ilovelawyer-app#972) end to end, through the real routes against the real
 * database: a paid engagement closes with an outcome; "work finished" refunds nothing and starts the
 * earning's hold; "can't continue" never refunds automatically: it goes to an admin, who decides the
 * refund from the reason and any work claimed, and nothing of the earning is released until it's settled. Also a free first
 * consultation, a disputed payment, a refund that fails or gets no answer, the client ending it, the
 * client being told, and the lawyer not being offered the case again. The dummy providers stand in for
 * Stripe unless a test sets a fake. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after, beforeEach, afterEach } from "mocha";
import request from "supertest";
import Stripe from "stripe";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import { redis } from "../src/lib/redis";
import { givePracticeArea } from "./support/practice-area-fixture";
import loginToken from "../src/utils/loginToken";
import ClientBillingSvc from "../src/services/client-billing.service";
import QuotationPaymentSvc from "../src/services/quotation-payment.service";
import WalletSvc from "../src/services/wallet.service";
import WalletRepo from "../src/repositories/wallet.repository";
import SecurityAuditRepo from "../src/repositories/security-audit.repository";
import * as mailerModule from "../src/utils/mailer";
import type { ClientRefundResult } from "../src/payments/client-refunds";
import { setQuotationPaymentProvider, QUOTATION_PAYMENT_PURPOSE, type IntentQuotationPaymentProvider, type QuotationPaymentResult } from "../src/payments/quotation-payment-provider";
import { payoutSettingsCacheKey } from "../src/constants/payout.constants";
import ClientRequestSvc from "../src/services/client-request.service";
import ClientRequestBriefSvc from "../src/services/client-request-brief.service";
import { CLIENT_REQUEST_CONSENT_VERSION, CLIENT_REQUEST_DIRECT_CONSENT_VERSION } from "../src/constants/client-request.constants";
import HttpError from "../src/utils/http-error";
import type { ClientWorkspace } from "../src/services/client-case.service";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

describe("lawyer exit", function () {
  this.timeout(20_000);
  const lawyerId = crypto.randomUUID();
  const otherLawyerId = crypto.randomUUID();
  const clientId = crypto.randomUUID();
  const adminId = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  const clientOrgId = crypto.randomUUID();
  const caseId = crypto.randomUUID();
  const webhookEvents: string[] = [];
  let tenantId: string;
  let requestId: string;

  const auth = (id: string) => ({ Authorization: `Bearer ${loginToken(id, false).accessToken}` });
  const asLawyer = { ...auth(lawyerId), "X-Organization-Id": orgId };
  const draft = (body: object) => request(app).put(`/api/client-requests/${requestId}/quotation`).set(asLawyer).send(body);
  const send = () => request(app).post(`/api/client-requests/${requestId}/quotation/send`).set(asLawyer);
  const accept = (quotationId: string) => request(app).post(`/api/client/lawyer-requests/${requestId}/quotations/${quotationId}/accept`).set(auth(clientId)).send({ disclosureAcknowledged: true });
  const pay = (quotationId: string) => request(app).post(`/api/client/lawyer-requests/${requestId}/quotations/${quotationId}/payment`).set(auth(clientId)).send({});
  const close = (body: object) => request(app).post(`/api/client-requests/${requestId}/close`).set(asLawyer).send(body);
  const confirmFinished = () => request(app).post(`/api/client/lawyer-requests/${requestId}/completion/confirm`).set(auth(clientId)).send({});
  const lawyerView = () => request(app).get(`/api/client-requests/${requestId}`).set(asLawyer);
  const clientView = () => request(app).get(`/api/client/lawyer-requests/${requestId}`).set(auth(clientId));
  const exits = (query = "") => request(app).get(`/api/admin/lawyer-exits${query}`).set(auth(adminId));
  const decide = (id: string, amountMinor: number, note?: string) =>
    request(app).post(`/api/admin/lawyer-exits/${id}/decide`).set(auth(adminId)).send({ refund: { amountMinor, currency: "GBP" }, ...(note ? { note } : {}) });

  const inDays = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString();
  const FIXED_FEE = { type: "FIXED_FEE", amount: { amountMinor: 60000, currency: "GBP" }, message: "I can take this on for a fixed fee.", expiresAt: inDays(5) };
  const CANT_CONTINUE = { outcome: "CANT_CONTINUE", reason: "CONFLICT", workDone: false, note: "I act for Acme Ltd, the other side." };
  const CLAIMED = (amountMinor: number) => ({
    outcome: "CANT_CONTINUE",
    reason: "CAPACITY",
    workDone: true,
    claimed: { amountMinor, currency: "GBP" },
    claimNote: "Reviewed the contract and drafted a letter before claim.",
  });

  const quoted = async (body: object = FIXED_FEE) => {
    await draft(body).expect(200);
    return (await send().expect(200)).body.quotation.id as string;
  };
  /** Quoted, accepted and paid with the dummy (or the fake Stripe a test set). */
  const engaged = async () => {
    const id = await quoted();
    await accept(id).expect(200);
    await pay(id).expect(200);
    return id;
  };
  const paymentRow = () => prisma.quotationPayment.findFirstOrThrow({ where: { requestId, status: { notIn: ["PENDING", "FAILED", "CANCELED"] } } });
  const earningRow = () => prisma.earning.findFirstOrThrow({ where: { requestId } });
  const exitRow = () => prisma.lawyerExit.findUniqueOrThrow({ where: { requestId } });
  const walletOf = async () => WalletSvc.get({ ownerType: "ORGANIZATION", ownerId: orgId });
  /** Releases this test's earning as the sweep would at `at`, if it's due then. Never the sweep
   * itself: that would release every due earning in the database, not only this test's. */
  const releaseAt = async (days: number) => WalletRepo.release(await earningRow(), new Date(Date.now() + days * DAY_MS));

  // Every security audit row written, and every email sent, during a test.
  let audits: { action: string; payload?: Record<string, unknown> }[];
  let emails: { to: string; subject: string; text?: string }[];
  const repo = SecurityAuditRepo as unknown as { create: (data: object) => Promise<object> };
  const realCreate = repo.create;
  const realSendEmail = mailerModule.sendEmail;

  before(async () => {
    const tenant = await prisma.tenant.upsert({ where: { code: "UK" }, update: {}, create: { code: "UK", name: "United Kingdom" } });
    tenantId = tenant.id;
    const user = (id: string, name: string, role: "LAWYER" | "USER" | "ADMIN") => ({ id, email: `exit-${id}@example.com`, username: `exit-${id}`, name, role, tenantId: tenant.id });
    await prisma.user.createMany({
      data: [user(lawyerId, "Lena Lawyer", "LAWYER"), user(otherLawyerId, "Omar Other", "LAWYER"), user(clientId, "Clara Client", "USER"), user(adminId, "Ann Admin", "ADMIN")],
    });
    await prisma.organization.create({
      data: { id: orgId, name: "Lena Law LLP", slug: `exit-${orgId}`, tenantId: tenant.id, createdById: lawyerId, members: { create: [{ userId: lawyerId, role: "OWNER", status: "ACCEPTED" }] } },
    });
    await prisma.organization.create({
      data: { id: clientOrgId, name: "Clara Client", slug: `exit-${clientOrgId}`, tenantId: tenant.id, createdById: clientId, isPersonal: true, members: { create: { userId: clientId, role: "OWNER", status: "ACCEPTED" } } },
    });
    for (const [id, number] of [
      [lawyerId, "9721"],
      [otherLawyerId, "9722"],
    ]) {
      await prisma.lawyerClientProfile.create({ data: { userId: id, acceptingRequests: true, verificationStatus: "VERIFIED", verifiedAt: new Date() } });
      await prisma.lawyerUkRegistration.create({ data: { userId: id, regulator: "SRA", registrationNumber: number, qualifiedJurisdictions: ["England and Wales"] } });
    }
    await givePracticeArea([lawyerId, otherLawyerId]);
    await prisma.case.create({ data: { id: caseId, userId: clientId, organizationId: clientOrgId, caseName: "Unfair dismissal", caseAreas: ["EMPLOYMENT"], ukJurisdiction: "England and Wales" } });
  });

  const cleanWallet = async () => {
    const w = await prisma.wallet.findUnique({ where: { ownerType_ownerId: { ownerType: "ORGANIZATION", ownerId: orgId } } });
    if (!w) return;
    await prisma.walletLedgerEntry.deleteMany({ where: { walletId: w.id } });
    await prisma.earning.deleteMany({ where: { walletId: w.id } });
    await prisma.withdrawal.deleteMany({ where: { walletId: w.id } });
    await prisma.wallet.delete({ where: { id: w.id } });
  };

  const cleanRequests = async () => {
    await prisma.lawyerExit.deleteMany({ where: { caseId } });
    await prisma.quotationPayment.deleteMany({ where: { clientId } });
    await prisma.clientRequest.deleteMany({ where: { caseId } });
    await prisma.caseAccess.deleteMany({ where: { caseId } });
    await prisma.notification.deleteMany({ where: { userId: { in: [lawyerId, otherLawyerId, clientId] } } });
  };

  after(async () => {
    await cleanWallet();
    await cleanRequests();
    await prisma.payoutSettings.deleteMany({ where: { tenantId } });
    await redis.del(payoutSettingsCacheKey(tenantId));
    await prisma.auditEvent.deleteMany({ where: { caseId } });
    await prisma.case.deleteMany({ where: { id: caseId } });
    await prisma.lawyerUkRegistration.deleteMany({ where: { userId: { in: [lawyerId, otherLawyerId] } } });
    await prisma.lawyerClientProfile.deleteMany({ where: { userId: { in: [lawyerId, otherLawyerId] } } });
    await prisma.organizationMember.deleteMany({ where: { userId: { in: [lawyerId, clientId] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgId, clientOrgId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [lawyerId, otherLawyerId, clientId, adminId] } } });
    await prisma.stripeWebhookEvent.deleteMany({ where: { id: { in: webhookEvents } } });
  });

  beforeEach(async () => {
    await cleanWallet();
    await cleanRequests();
    const now = new Date();
    const row = await prisma.clientRequest.create({
      data: { caseId, clientId, consentVersion: "test", consentAcceptedAt: now, status: "ROUTED", routedAt: now, routingExpiresAt: new Date(now.getTime() + 48 * HOUR_MS) },
    });
    requestId = row.id;
    await prisma.clientRequestClaim.create({ data: { requestId, lawyerId, organizationId: orgId, claimedAt: now, expiresAt: new Date(now.getTime() + 24 * HOUR_MS) } });
    audits = [];
    emails = [];
    repo.create = async (data: object) => {
      audits.push(data as { action: string; payload?: Record<string, unknown> });
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
    setQuotationPaymentProvider(null);
  });

  describe("closing a paid engagement", () => {
    it("needs an outcome, and stays engaged without one", async () => {
      await engaged();
      expect((await lawyerView().expect(200)).body.engagement).to.deep.include({ paid: true, exit: null });
      expect((await close({}).expect(400)).body.code).to.equal("CLOSE_OUTCOME_REQUIRED");
      expect((await close({ outcome: "CANT_CONTINUE", workDone: false }).expect(400)).body.message).to.match(/reason/);
      expect((await prisma.clientRequest.findUniqueOrThrow({ where: { id: requestId } })).status).to.equal("ENGAGED");
    });

    it("keeps the earning from being withdrawn while the engagement is open, however long it runs", async () => {
      await engaged();
      expect((await earningRow()).availableAt).to.equal(null);
      expect(await releaseAt(365)).to.equal(null);
      expect((await walletOf()).balances.available.amountMinor).to.equal(0);
    });

    it("work finished: refunds nothing and starts the hold once the client confirms", async () => {
      await engaged();
      expect((await close({ outcome: "WORK_FINISHED", note: "All done." }).expect(200)).body.status).to.equal("ENGAGED");
      expect((await earningRow()).availableAt).to.equal(null);
      await confirmFinished().expect(200);
      const body = (await lawyerView().expect(200)).body;
      expect(body.status).to.equal("CLOSED");
      expect(body.engagement).to.deep.include({ paid: true, exit: null });
      expect(await prisma.quotationRefund.count({ where: { paymentId: (await paymentRow()).id } })).to.equal(0);
      expect((await paymentRow()).status).to.equal("SUCCEEDED");
      const earning = await earningRow();
      expect(earning.status).to.equal("PENDING");
      expect(earning.availableAt!.getTime()).to.be.closeTo(Date.now() + 7 * DAY_MS, 60_000);
      expect(await prisma.lawyerExit.count({ where: { requestId } })).to.equal(0);
      expect(await releaseAt(6)).to.equal(null);
      expect(await releaseAt(8)).to.not.equal(null);
    });

    it("asks the client by bell and email to confirm when the lawyer says the work is finished", async () => {
      await engaged();
      await close({ outcome: "WORK_FINISHED" }).expect(200);
      const bell = await prisma.notification.findFirstOrThrow({ where: { userId: clientId }, orderBy: { createdAt: "desc" } });
      expect(bell.title).to.equal("Lena Lawyer says the work on your case is finished");
      expect(emails.map((e) => [e.to, e.subject])).to.deep.equal([[`exit-${clientId}@example.com`, "Lena Lawyer says the work on your case is finished"]]);
    });
  });

  describe("can't continue, no work done", () => {
    it("refunds nothing by itself: it waits on an admin, and nothing is released", async () => {
      await engaged();
      const body = (await close(CANT_CONTINUE).expect(200)).body;
      expect(body.status).to.equal("CLOSED");
      expect(body.engagement.exit).to.deep.include({ status: "AWAITING_REVIEW", reason: "CONFLICT", workDone: false, claimed: null });
      expect(body.engagement.exit.refunded.amountMinor).to.equal(0);

      expect(await paymentRow()).to.deep.include({ status: "SUCCEEDED", refundedMinor: 0 });
      expect(await prisma.quotationRefund.count({ where: { paymentId: (await paymentRow()).id } })).to.equal(0);
      expect((await earningRow()).availableAt).to.equal(null);
      expect(await releaseAt(365)).to.equal(null);

      // In the admin's queue, with the lawyer's reason and note to decide on.
      const row = (await exits().expect(200)).body.data.find((e: { requestId: string }) => e.requestId === requestId);
      expect(row).to.deep.include({ status: "AWAITING_REVIEW", reason: "CONFLICT", workDone: false, note: "I act for Acme Ltd, the other side." });
      expect(row.payment.refundable.amountMinor).to.equal(60000);
    });

    it("the admin approves a full refund: the platform fee included, and the earning reversed", async () => {
      await engaged();
      await close(CANT_CONTINUE).expect(200);
      const decided = (await decide((await exitRow()).id, 60000, "Genuine conflict").expect(200)).body;
      expect(decided).to.deep.include({ status: "SETTLED" });
      expect(decided.refunded.amountMinor).to.equal(60000);

      const payment = await paymentRow();
      expect(payment).to.deep.include({ status: "REFUNDED", refundedMinor: 60000 });
      const refund = await prisma.quotationRefund.findFirstOrThrow({ where: { paymentId: payment.id } });
      expect(refund).to.deep.include({ amountMinor: 60000, serviceFeeMinor: 51000, platformFeeMinor: 9000, status: "SUCCEEDED", createdById: adminId });
      expect((await earningRow()).status).to.equal("REVERSED");
      expect((await walletOf()).balances.pending.amountMinor).to.equal(0);

      // The client is emailed that it went through, never the admin's note.
      const sent = emails.find((e) => e.subject === "Your refund of £600.00 has been sent");
      expect(sent?.to).to.equal(`exit-${clientId}@example.com`);
      expect(sent?.text).to.include("refunded your whole payment of £600.00, ilovelawyer's fee included");
      expect(sent?.text).to.include("5 to 10 working days");
      expect(sent?.text).to.not.include("Genuine conflict");
    });

    it("the admin can refuse a refund when the reason doesn't hold up: the lawyer's fee is released after the hold", async () => {
      await engaged();
      await close(CANT_CONTINUE).expect(200);
      await decide((await exitRow()).id, 0, "Reason not supported").expect(200);
      expect(await exitRow()).to.deep.include({ status: "SETTLED", refundedMinor: 0 });
      expect(emails.filter((e) => e.subject.startsWith("Your refund of"))).to.have.length(0);
      expect((await paymentRow()).status).to.equal("SUCCEEDED");
      expect(await releaseAt(8)).to.not.equal(null);
      const bell = await prisma.notification.findFirstOrThrow({ where: { userId: clientId, title: "We've reviewed your refund" } });
      expect(bell.message).to.equal("We looked at why your lawyer stopped acting. No refund is due.");
    });

    it("audits the decided refund with its reason, and keeps the note out of the activity feed and the audit log", async () => {
      await engaged();
      await close(CANT_CONTINUE).expect(200);
      await decide((await exitRow()).id, 60000).expect(200);
      const refunded = audits.find((a) => a.action === "admin.quotation_payment.refunded");
      expect(refunded?.payload).to.deep.include({ amountMinor: 60000, status: "SUCCEEDED" });
      expect(refunded?.payload?.reason).to.match(/couldn't continue \(a conflict\)/);
      expect(audits.find((a) => a.action === "system.quotation_payment.refunded")).to.equal(undefined);
      expect(audits.find((a) => a.action === "client_request.closed")?.payload).to.deep.include({ outcome: "CANT_CONTINUE", reason: "CONFLICT" });
      expect(JSON.stringify(audits)).to.not.include("Acme");
      const feed = (await prisma.auditEvent.findMany({ where: { caseId, action: "client_request.closed" } })).filter((e) => (e.payload as { requestId?: string }).requestId === requestId);
      expect(feed).to.have.length(1);
      expect(JSON.stringify(feed[0]!.payload)).to.not.include("Acme");
      expect((await exitRow()).note).to.equal("I act for Acme Ltd, the other side.");
    });

    it("shows the client the refund and where it stands, never why the lawyer left", async () => {
      await engaged();
      await close(CANT_CONTINUE).expect(200);
      const waiting = (await clientView().expect(200)).body;
      expect(waiting.status).to.equal("CLOSED");
      expect(waiting.refund.lawyerExit).to.deep.include({ status: "AWAITING_REVIEW" });
      expect(waiting.refund.refunded.amountMinor).to.equal(0);
      expect(emails[0]!.text).to.include("We're reviewing your refund");
      expect(emails[0]!.text).to.not.include("in full");

      await decide((await exitRow()).id, 60000).expect(200);
      const view = (await clientView().expect(200)).body;
      expect(view.refund).to.deep.include({ paid: { amountMinor: 60000, currency: "GBP" }, refunded: { amountMinor: 60000, currency: "GBP" } });
      expect(view.refund.refunds).to.have.length(1);
      expect(view.refund.lawyerExit).to.deep.include({ status: "SETTLED" });
      expect(JSON.stringify(view)).to.not.include("Acme").and.not.include("CONFLICT");

      const bells = await prisma.notification.findMany({ where: { userId: clientId }, orderBy: { createdAt: "asc" } });
      expect(bells.map((b) => b.title)).to.include.members(["Lena Lawyer can't continue with your case", "Your refund is on its way"]);
    });
  });

  describe("can't continue, work claimed", () => {
    it("can't claim more than the lawyer's share", async () => {
      await engaged();
      const { body } = await close(CLAIMED(51001)).expect(400);
      expect(body.code).to.equal("CLAIM_EXCEEDS_FEE");
      expect(body.maximum).to.deep.equal({ amountMinor: 51000, currency: "GBP" });
    });

    it("reaches an admin, and nothing is released until it's settled", async () => {
      await engaged();
      const body = (await close(CLAIMED(20000)).expect(200)).body;
      expect(body.engagement.exit).to.deep.include({ status: "AWAITING_REVIEW", workDone: true });
      expect(body.engagement.exit.claimed.amountMinor).to.equal(20000);
      expect(await prisma.quotationRefund.count({ where: { paymentId: (await paymentRow()).id } })).to.equal(0);
      expect((await earningRow()).availableAt).to.equal(null);
      expect(await releaseAt(365)).to.equal(null);

      const queue = (await exits().expect(200)).body;
      const row = queue.data.find((e: { requestId: string }) => e.requestId === requestId);
      expect(row).to.deep.include({ status: "AWAITING_REVIEW", reason: "CAPACITY", workDone: true, claimNote: "Reviewed the contract and drafted a letter before claim." });
      expect(row.claimed.amountMinor).to.equal(20000);
      expect(row.payment).to.deep.include({ status: "SUCCEEDED" });
      expect([row.payment.refundable.amountMinor, row.payment.refundableServiceFee.amountMinor]).to.deep.equal([60000, 51000]);
      expect(row.lawyer).to.deep.include({ name: "Lena Lawyer", firmName: "Lena Law LLP" });

      // The payment's detail carries the exit too.
      const payments = (await request(app).get("/api/admin/quotation-payments").set(auth(adminId)).expect(200)).body.data;
      expect(payments.find((p: { requestId: string }) => p.requestId === requestId).lawyerExit).to.deep.include({ status: "AWAITING_REVIEW", reason: "CAPACITY" });
      expect(emails[0]!.text).to.include("We're reviewing your refund");
    });

    it("the admin's decision refunds the unworked part from the lawyer's share and keeps the platform fee", async () => {
      await engaged();
      await close(CLAIMED(20000)).expect(200);
      const exit = await exitRow();
      const decided = (await decide(exit.id, 31000, "Claim looks right").expect(200)).body;
      expect(decided).to.deep.include({ status: "SETTLED" });
      expect(decided.refunded.amountMinor).to.equal(31000);
      expect(decided.decision.note).to.equal("Claim looks right");
      const sent = emails.find((e) => e.subject === "Your refund of £310.00 has been sent");
      expect(sent?.text).to.include("refunded £310.00 of the £600.00 you paid");
      expect(sent?.text).to.not.include("Claim looks right");

      const payment = await paymentRow();
      expect(payment).to.deep.include({ status: "PARTIALLY_REFUNDED", refundedMinor: 31000 });
      const refund = await prisma.quotationRefund.findFirstOrThrow({ where: { paymentId: payment.id } });
      expect(refund).to.deep.include({ serviceFeeMinor: 31000, platformFeeMinor: 0, createdById: adminId });
      const earning = await earningRow();
      expect(earning).to.deep.include({ status: "PENDING", reversedMinor: 31000 });
      // The hold counts from the close.
      const closedAt = (await prisma.clientRequest.findUniqueOrThrow({ where: { id: requestId } })).closedAt!;
      expect(earning.availableAt!.getTime()).to.equal(closedAt.getTime() + 7 * DAY_MS);
      expect(audits.find((a) => a.action === "admin.lawyer_exit.decided")?.payload).to.deep.include({ amountMinor: 31000 });
      expect(audits.find((a) => a.action === "admin.quotation_payment.refunded")?.payload?.reason).to.match(/couldn't continue/);
      expect(JSON.stringify(audits)).to.not.include("Claim looks right");

      expect((await decide(exit.id, 0).expect(409)).body.code).to.equal("LAWYER_EXIT_NOT_OPEN");
      expect(await releaseAt(8)).to.not.equal(null);
      expect((await walletOf()).balances.available.amountMinor).to.equal(20000);
    });

    it("an admin can decide nothing is due, or that everything goes back, the platform fee too", async () => {
      await engaged();
      await close(CLAIMED(51000)).expect(200);
      const nothing = (await decide((await exitRow()).id, 0).expect(200)).body;
      expect(nothing).to.deep.include({ status: "SETTLED" });
      expect((await paymentRow()).status).to.equal("SUCCEEDED");
      expect((await earningRow()).availableAt).to.not.equal(null);

      // Another engagement on the same case, where the reason wasn't good enough.
      await cleanRequests();
      await cleanWallet();
      const now = new Date();
      requestId = (await prisma.clientRequest.create({ data: { caseId, clientId, consentVersion: "test", consentAcceptedAt: now, status: "ROUTED", routedAt: now, routingExpiresAt: new Date(now.getTime() + 48 * HOUR_MS) } })).id;
      await prisma.clientRequestClaim.create({ data: { requestId, lawyerId, organizationId: orgId, claimedAt: now, expiresAt: new Date(now.getTime() + 24 * HOUR_MS) } });
      await engaged();
      await close(CLAIMED(10000)).expect(200);
      const id = (await exitRow()).id;
      // Between the lawyer's share and everything: neither a partial nor a full refund.
      expect((await decide(id, 55000).expect(400)).body.code).to.equal("REFUND_EXCEEDS_CHARGE");
      await decide(id, 60000).expect(200);
      expect(await paymentRow()).to.deep.include({ status: "REFUNDED", refundedMinor: 60000 });
      expect((await prisma.quotationRefund.findFirstOrThrow({ where: { paymentId: (await paymentRow()).id } })).platformFeeMinor).to.equal(9000);
      expect((await earningRow()).status).to.equal("REVERSED");
    });
  });

  describe("with nothing paid through ilovelawyer", () => {
    const FREE = { type: "FIRST_CONSULTATION", amount: { amountMinor: 0, currency: "GBP" }, message: "First call is free.", expiresAt: inDays(3) };

    it("a free first consultation is finished with no outcome, no refund and no error", async () => {
      await accept(await quoted(FREE)).expect(200);
      expect((await lawyerView().expect(200)).body.engagement.paid).to.equal(false);
      const body = (await close({}).expect(200)).body;
      expect(body.engagement.completion.requestedAt).to.be.a("string");
      await confirmFinished().expect(200);
      expect((await lawyerView().expect(200)).body.status).to.equal("CLOSED");
      expect(await prisma.quotationRefund.count({ where: { payment: { requestId } } })).to.equal(0);
    });

    it("a lawyer who can't continue on one is settled at once, with nothing to refund", async () => {
      await accept(await quoted(FREE)).expect(200);
      const body = (await close({ ...CANT_CONTINUE, workDone: true, claimed: { amountMinor: 100, currency: "GBP" }, claimNote: "A call." }).expect(200)).body;
      expect(body.engagement.exit).to.deep.include({ status: "SETTLED", workDone: false, claimed: null });
      expect((await clientView().expect(200)).body.refund).to.equal(null);
    });
  });

  describe("with Stripe", () => {
    let stripeNow: Map<string, QuotationPaymentResult>;
    let refundAnswer: () => Promise<ClientRefundResult>;
    const fake: IntentQuotationPaymentProvider = {
      name: "STRIPE",
      mode: "intent",
      async createIntent(req) {
        return { paymentIntentId: `pi_${req.paymentId}`, clientSecret: `secret_${req.paymentId}`, publishableKey: "pk_test" };
      },
      async resumeIntent(pi) {
        return { paymentIntentId: pi, clientSecret: `secret_${pi}`, publishableKey: "pk_test", status: "PENDING", failureReason: null };
      },
      async status(pi) {
        return stripeNow.get(pi) ?? { status: "PENDING", paymentIntentId: pi, failureReason: null };
      },
      async cancel(pi) {
        return { status: "CANCELED", paymentIntentId: pi, failureReason: null };
      },
      async refund() {
        return refundAnswer();
      },
    };
    const paidWithStripe = async () => {
      const id = await quoted();
      await accept(id).expect(200);
      const { payment } = (await pay(id).expect(200)).body;
      const pi = `pi_${payment.id}`;
      stripeNow.set(pi, { status: "SUCCEEDED", paymentIntentId: pi, failureReason: null });
      const eventId = `evt_${crypto.randomUUID()}`;
      webhookEvents.push(eventId);
      await ClientBillingSvc.handleStripeEvent({ id: eventId, type: "payment_intent.succeeded", data: { object: { id: pi, metadata: { purpose: QUOTATION_PAYMENT_PURPOSE, paymentId: payment.id } } } } as unknown as Stripe.Event);
      return { paymentId: payment.id as string, pi };
    };
    const dispute = (pi: string, closedAs: string | null) =>
      QuotationPaymentSvc.applyStripeDispute({ id: `dp_${crypto.randomUUID()}`, payment_intent: pi, status: closedAs ?? "needs_response" } as unknown as Stripe.Dispute, closedAs === null);

    beforeEach(() => {
      stripeNow = new Map();
      refundAnswer = async () => ({ externalId: `re_${crypto.randomUUID()}`, status: "SUCCEEDED", failureReason: null });
      setQuotationPaymentProvider(fake);
    });

    it("doesn't refund a disputed payment: the bank decides, then it goes to an admin", async () => {
      const { pi } = await paidWithStripe();
      await dispute(pi, null);
      const body = (await close(CANT_CONTINUE).expect(200)).body;
      expect(body.engagement.exit.status).to.equal("WAITING_ON_DISPUTE");
      expect(await prisma.quotationRefund.count({ where: { paymentId: (await paymentRow()).id } })).to.equal(0);
      expect(emails[0]!.text).to.include("Your bank is looking at a dispute");

      // Won: still nothing refunded or released; an admin decides.
      await dispute(pi, "won");
      expect(await exitRow()).to.deep.include({ status: "AWAITING_REVIEW", refundedMinor: 0 });
      expect(await prisma.quotationRefund.count({ where: { paymentId: (await paymentRow()).id } })).to.equal(0);
      expect((await earningRow()).availableAt).to.equal(null);
      await decide((await exitRow()).id, 60000).expect(200);
      expect(await exitRow()).to.deep.include({ status: "SETTLED", refundedMinor: 60000 });
      expect((await earningRow()).status).to.equal("REVERSED");
    });

    it("settles an exit the bank decided for the client, with nothing more refunded", async () => {
      const { pi } = await paidWithStripe();
      await dispute(pi, null);
      await close(CANT_CONTINUE).expect(200);
      await dispute(pi, "lost");
      expect(await exitRow()).to.deep.include({ status: "SETTLED", refundedMinor: 0 });
      expect(await prisma.quotationRefund.count({ where: { paymentId: (await paymentRow()).id } })).to.equal(0);
      expect((await earningRow()).status).to.equal("REVERSED");
    });

    it("a dispute opened while an admin is deciding waits for the bank", async () => {
      const { pi } = await paidWithStripe();
      await close(CLAIMED(20000)).expect(200);
      await dispute(pi, null);
      const exit = await exitRow();
      expect(exit.status).to.equal("WAITING_ON_DISPUTE");
      expect((await decide(exit.id, 31000).expect(409)).body.code).to.equal("LAWYER_EXIT_NOT_OPEN");
      await dispute(pi, "warning_closed");
      expect((await exitRow()).status).to.equal("AWAITING_REVIEW");
      // Still held: the exit isn't settled.
      expect((await earningRow()).availableAt).to.equal(null);
    });

    it("hands a refund that fails to an admin rather than failing silently", async () => {
      await paidWithStripe();
      refundAnswer = async () => {
        throw new Stripe.errors.StripeInvalidRequestError({ message: "Refund refused", type: "invalid_request_error" });
      };
      await close(CANT_CONTINUE).expect(200);
      expect((await decide((await exitRow()).id, 60000).expect(502)).body.code).to.equal("REFUND_FAILED");
      const exit = await exitRow();
      expect(exit).to.deep.include({ status: "NEEDS_ATTENTION", failureReason: "Refund refused" });
      expect((await exits().expect(200)).body.data.map((e: { id: string }) => e.id)).to.include(exit.id);
      expect((await earningRow()).availableAt).to.equal(null);

      refundAnswer = async () => ({ externalId: `re_${crypto.randomUUID()}`, status: "SUCCEEDED", failureReason: null });
      await decide(exit.id, 60000).expect(200);
      expect(await exitRow()).to.deep.include({ status: "SETTLED", refundedMinor: 60000, failureReason: null });
      expect((await exits().expect(200)).body.data.map((e: { id: string }) => e.id)).to.not.include(exit.id);
    });

    it("waits for Stripe's webhook on a refund with no answer yet, then settles", async () => {
      await paidWithStripe();
      refundAnswer = async () => ({ externalId: `re_${crypto.randomUUID()}`, status: "PENDING", failureReason: null });
      await close(CANT_CONTINUE).expect(200);
      await decide((await exitRow()).id, 60000).expect(200);
      const exit = await exitRow();
      expect(exit.status).to.equal("REFUNDING");
      expect((await clientView().expect(200)).body.refund).to.deep.include({ pending: { amountMinor: 60000, currency: "GBP" } });
      expect(emails.filter((e) => e.subject.startsWith("Your refund of"))).to.have.length(0);

      await QuotationPaymentSvc.applyStripeRefund({ id: `re_${crypto.randomUUID()}`, status: "succeeded", metadata: { refundId: exit.refundId } } as unknown as Stripe.Refund);
      expect(await exitRow()).to.deep.include({ status: "SETTLED", refundedMinor: 60000, refundId: null });
      expect(emails.filter((e) => e.subject === "Your refund of £600.00 has been sent")).to.have.length(1);
    });

    it("a refund that fails at Stripe later lands in the admin's queue", async () => {
      await paidWithStripe();
      refundAnswer = async () => ({ externalId: `re_${crypto.randomUUID()}`, status: "PENDING", failureReason: null });
      await close(CANT_CONTINUE).expect(200);
      await decide((await exitRow()).id, 60000).expect(200);
      const { refundId } = await exitRow();
      await QuotationPaymentSvc.applyStripeRefund({ id: `re_${crypto.randomUUID()}`, status: "failed", failure_reason: "expired_or_canceled_card", metadata: { refundId } } as unknown as Stripe.Refund);
      expect(await exitRow()).to.deep.include({ status: "NEEDS_ATTENTION", failureReason: "expired_or_canceled_card" });
      expect(emails.filter((e) => e.subject.startsWith("Your refund of"))).to.have.length(0);
    });
  });

  describe("the client ending it", () => {
    it("refunds nothing and starts the lawyer's hold", async () => {
      await engaged();
      await request(app).post(`/api/client/lawyer-requests/${requestId}/end`).set(auth(clientId)).send({}).expect(200);
      const earning = await earningRow();
      expect(earning.availableAt!.getTime()).to.be.closeTo(Date.now() + 7 * DAY_MS, 60_000);
      expect((await paymentRow()).status).to.equal("SUCCEEDED");
    });
  });

  describe("asking for a lawyer again", () => {
    const workspace: ClientWorkspace = { id: clientOrgId, role: "OWNER", tenantCode: "UK" };
    const realGenerate = ClientRequestBriefSvc.generateInBackground;
    // The brief is AI-written in the background: not this test's business.
    beforeEach(() => {
      (ClientRequestBriefSvc as unknown as { generateInBackground: unknown }).generateInBackground = () => undefined;
    });
    afterEach(() => {
      (ClientRequestBriefSvc as unknown as { generateInBackground: unknown }).generateInBackground = realGenerate;
    });

    it("works on the same case, and the lawyer who left isn't offered it, nor can be asked by name", async () => {
      await engaged();
      await close(CANT_CONTINUE).expect(200);
      expect((await ClientRequestSvc.eligibility(workspace, caseId)).eligible).to.equal(true);
      const created = await ClientRequestSvc.create(workspace, clientId, { caseId, consentVersion: CLIENT_REQUEST_CONSENT_VERSION, consentAccepted: true });
      const row = await prisma.clientRequest.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.excludedLawyerIds).to.include(lawyerId);
      expect(row.excludedLawyerIds).to.not.include(otherLawyerId);
      await prisma.clientRequest.update({ where: { id: created.id }, data: { status: "WITHDRAWN" } });

      const refused = await ClientRequestSvc.create(workspace, clientId, { caseId, consentVersion: CLIENT_REQUEST_DIRECT_CONSENT_VERSION, consentAccepted: true, lawyerId }).catch((err: HttpError) => err);
      expect(refused).to.be.instanceOf(HttpError);
      expect(refused).to.deep.include({ statusCode: 422, code: "LAWYER_LEFT_CASE" });
    });
  });
});
