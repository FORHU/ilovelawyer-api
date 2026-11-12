/** The Support Chat's actions (SupportActionSvc): POST /api/client/support/actions/:key for a signed-in
 * client, GET .../deletion-check, and the signed-out POST /api/support/actions/:key. Through the real
 * routes against the real database. Stripe, the emails and AuthSvc's sends are replaced, and the
 * visitor routes are checked for what they reveal and for their rate limits. */
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
import ClientBillingSvc from "../src/services/client-billing.service";
import AuthSvc from "../src/services/auth.service";
import * as mailerModule from "../src/utils/mailer";

const tokenFor = (userId: string) => jwt.sign({ userId }, ACCESS_TOKEN_SECRET, { expiresIn: "1h" });
const DAY_MS = 24 * 60 * 60 * 1000;

describe("Support Chat actions", () => {
  const clientId = crypto.randomUUID();
  const googleId = crypto.randomUUID();
  const lawyerId = crypto.randomUUID();
  const ids = [clientId, googleId, lawyerId];
  const mark = crypto.randomUUID().slice(0, 6);
  let asClient: { Authorization: string };
  let asGoogle: { Authorization: string };
  let asLawyer: { Authorization: string };
  let workspaceId: string;
  let googleWorkspaceId: string;
  let caseA: string;
  let caseB: string;
  let pendingPaymentId: string;

  let saved: { sendEmail: unknown; paymentStatus: unknown; forgotPassword: unknown; sendOtp: unknown };
  let emails: { to: string; subject: string }[];
  let stripeChecks: string[];
  let forgot: { email: string; origin: string | null }[];
  let otp: string[];

  const run = (key: string, who: { Authorization: string } = asClient) => request(app).post(`/api/client/support/actions/${key}`).set(who).send({});
  const visitor = (key: string, email: unknown) => request(app).post(`/api/support/actions/${key}`).send({ email });
  const freshEmail = () => `visitor-${crypto.randomUUID()}@example.com`;

  before(async () => {
    const password = await bcrypt.hash("Sup3r-secret!", 4);
    await prisma.user.createMany({
      data: [
        { id: clientId, email: `act-client-${clientId}@example.com`, username: `act-client-${clientId}`, role: "USER", password },
        { id: googleId, email: `act-google-${googleId}@example.com`, username: `act-google-${googleId}`, role: "USER", provider: "google", password },
        { id: lawyerId, email: `act-lawyer-${lawyerId}@example.com`, username: `act-lawyer-${lawyerId}`, role: "LAWYER" },
      ],
    });
    asClient = { Authorization: `Bearer ${tokenFor(clientId)}` };
    asGoogle = { Authorization: `Bearer ${tokenFor(googleId)}` };
    asLawyer = { Authorization: `Bearer ${tokenFor(lawyerId)}` };
    workspaceId = (await ClientCaseSvc.workspaceFor(clientId, "Act Client")).id;
    googleWorkspaceId = (await ClientCaseSvc.workspaceFor(googleId, "Act Google")).id;

    caseA = (await prisma.case.create({ data: { userId: clientId, organizationId: workspaceId, caseName: `Case A ${mark}`, clientCredits: 4 } })).id;
    caseB = (await prisma.case.create({ data: { userId: clientId, organizationId: workspaceId, caseName: `Case B ${mark}`, clientCredits: 7 } })).id;
    await prisma.case.create({ data: { userId: clientId, organizationId: workspaceId, caseName: `Archived ${mark}`, clientCredits: 50, status: "ARCHIVED" } });

    const pay = (data: object) => prisma.clientPayment.create({ data: { userId: clientId, provider: "STRIPE", amountMinor: 1000, currency: "GBP", credits: 20, kind: "TOP_UP", status: "SUCCEEDED", caseId: caseA, ...data } as any });
    await pay({ createdAt: new Date(Date.now() - 40 * DAY_MS) });
    for (let i = 0; i < 5; i++) await pay({ createdAt: new Date(Date.now() - (i + 2) * 60 * 60 * 1000) });
    pendingPaymentId = (await pay({ status: "PENDING", externalId: `cs_test_${mark}`, createdAt: new Date() })).id;
  });

  after(async () => {
    await prisma.clientPayment.deleteMany({ where: { userId: { in: ids } } });
    await prisma.clientRequest.deleteMany({ where: { clientId: { in: ids } } });
    await prisma.case.deleteMany({ where: { organizationId: { in: [workspaceId, googleWorkspaceId] } } });
    await prisma.organization.deleteMany({ where: { createdById: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });

  beforeEach(() => {
    saved = {
      sendEmail: (mailerModule as any).sendEmail,
      paymentStatus: (ClientBillingSvc as any).paymentStatus,
      forgotPassword: (AuthSvc as any).forgotPassword,
      sendOtp: (AuthSvc as any).sendOtp,
    };
    emails = [];
    stripeChecks = [];
    forgot = [];
    otp = [];
    (mailerModule as any).sendEmail = async (mail: { to: string; subject: string }) => void emails.push(mail);
    (ClientBillingSvc as any).paymentStatus = async (userId: string, paymentId: string) => {
      stripeChecks.push(paymentId);
      await prisma.clientPayment.update({ where: { id: paymentId }, data: { status: "SUCCEEDED" } });
      return {};
    };
  });
  afterEach(async () => {
    (mailerModule as any).sendEmail = saved.sendEmail;
    (ClientBillingSvc as any).paymentStatus = saved.paymentStatus;
    (AuthSvc as any).forgotPassword = saved.forgotPassword;
    (AuthSvc as any).sendOtp = saved.sendOtp;
    await prisma.clientRequest.deleteMany({ where: { clientId: { in: ids } } });
    await prisma.clientPayment.update({ where: { id: pendingPaymentId }, data: { status: "PENDING" } });
  });

  describe("signed in", () => {
    it("is for client accounts only", async () => {
      await run("SHOW_CREDITS", asLawyer).expect(403);
      await request(app).post("/api/client/support/actions/SHOW_CREDITS").send({}).expect(401);
      await request(app).get("/api/client/support/actions/deletion-check").set(asLawyer).expect(403);
      await request(app).get("/api/client/support/actions/deletion-check").expect(401);
    });

    it("SHOW_CREDITS: credits on each active case, not the archived one", async () => {
      const { body } = await run("SHOW_CREDITS").expect(200);
      expect(body.cases).to.have.length(2);
      expect(body.cases.find((c: any) => c.caseId === caseA)).to.deep.equal({ caseId: caseA, title: `Case A ${mark}`, credits: 4 });
      expect(body.cases.find((c: any) => c.caseId === caseB)).to.deep.equal({ caseId: caseB, title: `Case B ${mark}`, credits: 7 });
    });

    it("CHECK_PAYMENT: re-checks a pending payment with Stripe and reports where it stands", async () => {
      const { body } = await run("CHECK_PAYMENT").expect(200);
      expect(stripeChecks).to.deep.equal([pendingPaymentId]);
      const checked = body.payments.find((p: any) => p.paymentId === pendingPaymentId);
      expect(checked).to.deep.include({ kind: "TOP_UP", status: "SUCCEEDED", credits: 20, caseId: caseA, caseTitle: `Case A ${mark}`, failureReason: null });
      expect(checked.amount).to.deep.equal({ amountMinor: 1000, currency: "GBP" });
    });

    it("CHECK_PAYMENT: the latest five from the last 30 days, newest first, without asking Stripe about settled ones", async () => {
      await prisma.clientPayment.update({ where: { id: pendingPaymentId }, data: { status: "SUCCEEDED" } });
      const { body } = await run("CHECK_PAYMENT").expect(200);
      expect(stripeChecks).to.deep.equal([]);
      expect(body.payments).to.have.length(5);
      const times = body.payments.map((p: any) => new Date(p.createdAt).getTime());
      expect(times).to.deep.equal([...times].sort((a, b) => b - a));
      expect(times.every((t: number) => t > Date.now() - 30 * DAY_MS)).to.equal(true);
    });

    it("CHECK_PAYMENT: a payment still pending after the check stays pending, and a failed check doesn't fail the action", async () => {
      (ClientBillingSvc as any).paymentStatus = async (_userId: string, paymentId: string) => {
        stripeChecks.push(paymentId);
        throw new Error("Stripe is down");
      };
      const { body } = await run("CHECK_PAYMENT").expect(200);
      expect(body.payments.find((p: any) => p.paymentId === pendingPaymentId).status).to.equal("PENDING");
    });

    it("SHOW_LAWYER_REQUESTS: status, case, and when a routed one lapses", async () => {
      const lapses = new Date(Date.now() + 40 * 60 * 60 * 1000);
      const routed = await prisma.clientRequest.create({ data: { caseId: caseA, clientId, consentVersion: "test", consentAcceptedAt: new Date(), status: "ROUTED", routingExpiresAt: lapses } });
      const closed = await prisma.clientRequest.create({ data: { caseId: caseB, clientId, consentVersion: "test", consentAcceptedAt: new Date(), status: "CLOSED" } });
      const { body } = await run("SHOW_LAWYER_REQUESTS").expect(200);
      const a = body.requests.find((r: any) => r.id === routed.id);
      expect(a).to.deep.include({ caseId: caseA, caseTitle: `Case A ${mark}`, status: "ROUTED", lawyerName: null });
      expect(new Date(a.expiresAt).getTime()).to.equal(lapses.getTime());
      expect(body.requests.find((r: any) => r.id === closed.id)).to.deep.include({ status: "CLOSED", expiresAt: null });
    });

    it("SEND_PASSWORD_RESET: emails the client's own address", async () => {
      (AuthSvc as any).forgotPassword = async (email: string, origin: string | null) => void forgot.push({ email, origin });
      const { body } = await run("SEND_PASSWORD_RESET").expect(200);
      expect(body).to.deep.equal({ sent: true });
      expect(forgot.map((f) => f.email)).to.deep.equal([`act-client-${clientId}@example.com`]);
    });

    it("SEND_PASSWORD_RESET: a Google account is told it signs in with Google (and AuthSvc emails it that)", async () => {
      (AuthSvc as any).forgotPassword = async (email: string, origin: string | null) => void forgot.push({ email, origin });
      const { body } = await run("SEND_PASSWORD_RESET", asGoogle).expect(200);
      expect(body).to.deep.equal({ sent: false, reason: "GOOGLE_ACCOUNT" });
      expect(forgot).to.have.length(1);
    });

    it("sends a real reset email through AuthSvc", async () => {
      await run("SEND_PASSWORD_RESET").expect(200);
      expect(emails.map((e) => e.to)).to.deep.equal([`act-client-${clientId}@example.com`]);
      expect(emails[0].subject).to.equal("Reset your password");
    });

    it("keeps export, delete and ticket on their own endpoints, and refuses unknown keys", async () => {
      for (const key of ["EXPORT_MY_DATA", "DELETE_MY_ACCOUNT", "OPEN_TICKET", "RESEND_CODE"]) {
        const res = await run(key).expect(400);
        expect(res.body.code, key).to.equal("ACTION_NOT_DISPATCHABLE");
      }
      expect((await run("REFUND_EVERYTHING").expect(404)).body.code).to.equal("UNKNOWN_ACTION");
    });

    it("deletion-check: lists blocking requests with what to do, whether a password is needed, and the credits lost", async () => {
      const routed = await prisma.clientRequest.create({ data: { caseId: caseA, clientId, consentVersion: "test", consentAcceptedAt: new Date(), status: "ROUTED" } });
      const engaged = await prisma.clientRequest.create({ data: { caseId: caseB, clientId, consentVersion: "test", consentAcceptedAt: new Date(), status: "ENGAGED" } });
      await prisma.clientRequest.create({ data: { caseId: caseB, clientId, consentVersion: "test", consentAcceptedAt: new Date(), status: "WITHDRAWN" } });
      const { body } = await request(app).get("/api/client/support/actions/deletion-check").set(asClient).expect(200);
      expect(body.blocking.map((r: any) => [r.id, r.action])).to.have.deep.members([
        [routed.id, "WITHDRAW"],
        [engaged.id, "END"],
      ]);
      expect(body.hasPassword).to.equal(true);
      expect(body.creditsRemaining).to.equal(11);
    });

    it("deletion-check: nothing blocks, and a Google account needs no password", async () => {
      const { body } = await request(app).get("/api/client/support/actions/deletion-check").set(asGoogle).expect(200);
      expect(body).to.deep.equal({ blocking: [], hasPassword: false, creditsRemaining: 0 });
    });
  });

  describe("signed out", () => {
    it("answers the same for an address with an account and one without, and passes both on", async () => {
      (AuthSvc as any).forgotPassword = async (email: string, origin: string | null) => void forgot.push({ email, origin });
      const known = await visitor("SEND_PASSWORD_RESET", `act-client-${clientId}@example.com`).expect(200);
      const unknown = await visitor("SEND_PASSWORD_RESET", freshEmail()).expect(200);
      expect(known.body).to.deep.equal({ ok: true });
      expect(unknown.body).to.deep.equal(known.body);
      expect(forgot).to.have.length(2);
    });

    it("RESEND_CODE asks AuthSvc for a new code and answers { ok: true }", async () => {
      (AuthSvc as any).sendOtp = async (email: string) => void otp.push(email);
      const email = freshEmail();
      expect((await visitor("RESEND_CODE", email).expect(200)).body).to.deep.equal({ ok: true });
      expect(otp).to.deep.equal([email]);
    });

    it("answers { ok: true } even when sending fails, so a failure says nothing either", async () => {
      (AuthSvc as any).forgotPassword = async () => {
        throw new Error("SMTP down");
      };
      expect((await visitor("SEND_PASSWORD_RESET", freshEmail()).expect(200)).body).to.deep.equal({ ok: true });
    });

    it("runs nothing that reads an account, and refuses a bad address", async () => {
      for (const key of ["CHECK_PAYMENT", "SHOW_CREDITS", "SHOW_LAWYER_REQUESTS", "EXPORT_MY_DATA", "DELETE_MY_ACCOUNT", "OPEN_TICKET", "NOPE"]) {
        await visitor(key, freshEmail()).expect(404);
      }
      await visitor("SEND_PASSWORD_RESET", "not-an-email").expect(400);
      await request(app).post("/api/support/actions/SEND_PASSWORD_RESET").send({}).expect(400);
    });


    it("limits requests per address, and refuses an unknown address exactly as a known one", async () => {
      (AuthSvc as any).forgotPassword = async () => undefined;
      const bodies: string[] = [];
      for (const email of [freshEmail(), `act-google-${googleId}@example.com`]) {
        for (let i = 0; i < 5; i++) await visitor("SEND_PASSWORD_RESET", email).expect(200);
        const limited = await visitor("SEND_PASSWORD_RESET", email).expect(429);
        expect(limited.body.message).to.not.match(/account|exist|registered/i);
        bodies.push(limited.body.message);
      }
      expect(bodies[0]).to.equal(bodies[1]);
    });

    it("counts the two actions separately for one address", async () => {
      (AuthSvc as any).forgotPassword = async () => undefined;
      (AuthSvc as any).sendOtp = async () => undefined;
      const email = freshEmail();
      for (let i = 0; i < 5; i++) await visitor("SEND_PASSWORD_RESET", email).expect(200);
      await visitor("SEND_PASSWORD_RESET", email).expect(429);
      await visitor("RESEND_CODE", email).expect(200);
    });
  });
});
