/** The thread between a client and each lawyer on their request (#517; one per lawyer from joining
 * since phase 5b): GET/POST /client-requests/:id/messages (lawyer) and
 * /client/lawyer-requests/:id/messages?claimId= (client), and the .../messages/read markers. Through
 * the real routes against the real database, on a request set up as ENGAGED (or back before hire)
 * directly (the charge that gets it there is #513's tests' concern). Socket events are captured in
 * memory. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after, beforeEach, afterEach } from "mocha";
import request from "supertest";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import * as config from "../src/config";
import * as socket from "../src/lib/socket";
import loginToken from "../src/utils/loginToken";
import ClientRequestRepo from "../src/repositories/client-request.repository";

describe("engagement thread (#517)", () => {
  const lawyerId = crypto.randomUUID();
  const otherLawyerId = crypto.randomUUID();
  const clientId = crypto.randomUUID();
  const otherClientId = crypto.randomUUID();
  const caseId = crypto.randomUUID();
  const documentId = crypto.randomUUID();
  let requestId: string;
  let claimId: string;
  let emitted: { userId: string; event: string; payload: any }[];
  const realEmit = socket.emitToUser;
  const cfg = config as unknown as Record<string, unknown>;
  const savedEncryption = { enabled: cfg.FIELD_ENCRYPTION_ENABLED, key: cfg.FIELD_ENCRYPTION_KEY };

  const auth = (id: string) => ({ Authorization: `Bearer ${loginToken(id, false).accessToken}` });
  const asLawyer = (id = lawyerId) => ({ ...auth(id), "X-Organization-Id": `user:${id}` });
  const lawyer = {
    list: (id = lawyerId) => request(app).get(`/api/client-requests/${requestId}/messages`).set(asLawyer(id)),
    post: (body: object, id = lawyerId) => request(app).post(`/api/client-requests/${requestId}/messages`).set(asLawyer(id)).send(body),
    read: () => request(app).post(`/api/client-requests/${requestId}/messages/read`).set(asLawyer()),
  };
  // `claim` names the lawyer's thread; left out, it's the hired lawyer's.
  const on = (claim?: string) => (claim ? `?claimId=${claim}` : "");
  const client = {
    list: (id = clientId, claim?: string) => request(app).get(`/api/client/lawyer-requests/${requestId}/messages${on(claim)}`).set(auth(id)),
    post: (body: object, id = clientId, claim?: string) => request(app).post(`/api/client/lawyer-requests/${requestId}/messages${on(claim)}`).set(auth(id)).send(body),
    read: (claim?: string) => request(app).post(`/api/client/lawyer-requests/${requestId}/messages/read${on(claim)}`).set(auth(clientId)),
  };

  /** Back before hire: the request open to lawyers, and the lawyer's claim on it open. */
  async function beforeHire() {
    await prisma.clientRequestClaim.updateMany({ where: { requestId }, data: { outcome: null } });
    await prisma.clientRequest.update({ where: { id: requestId }, data: { status: "ROUTED", engagedAt: null } });
  }

  before(async () => {
    const tenant = await prisma.tenant.upsert({ where: { code: "UK" }, update: {}, create: { code: "UK", name: "United Kingdom" } });
    const standardPlan = await prisma.paymentPlan.findFirstOrThrow({ where: { tenantId: tenant.id, planType: "B2B_SUBSCRIPTION", code: "standard" } });
    const lawyerRow = (id: string, name: string) => ({ id, email: `thread-${id}@example.com`, username: `thread-${id}`, name, role: "LAWYER" as const, tenantId: tenant.id, paymentPlanId: standardPlan.id });
    await prisma.user.createMany({
      data: [
        lawyerRow(lawyerId, "Lena Lawyer"),
        lawyerRow(otherLawyerId, "Omar Other"),
        { id: clientId, email: `thread-client-${clientId}@example.com`, username: `thread-client-${clientId}`, name: "Clara Client", role: "USER", tenantId: tenant.id },
        { id: otherClientId, email: `thread-other-${otherClientId}@example.com`, username: `thread-other-${otherClientId}`, name: "Someone Else", role: "USER", tenantId: tenant.id },
      ],
    });
    await prisma.case.create({ data: { id: caseId, userId: clientId, caseName: "Thread test case", caseAreas: ["EMPLOYMENT"], ukJurisdiction: "England and Wales" } });
    await prisma.document.create({ data: { id: documentId, userId: clientId, caseId, name: "Dismissal letter.pdf", mimeType: "application/pdf" } });
  });

  after(async () => {
    Object.assign(socket, { emitToUser: realEmit });
    Object.assign(cfg, { FIELD_ENCRYPTION_ENABLED: savedEncryption.enabled, FIELD_ENCRYPTION_KEY: savedEncryption.key });
    await prisma.clientRequest.deleteMany({ where: { caseId } });
    await prisma.document.deleteMany({ where: { id: documentId } });
    await prisma.case.deleteMany({ where: { id: caseId } });
    await prisma.organizationMember.deleteMany({ where: { userId: { in: [lawyerId, otherLawyerId, clientId, otherClientId] } } });
    await prisma.organization.deleteMany({ where: { createdById: { in: [lawyerId, otherLawyerId, clientId, otherClientId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [lawyerId, otherLawyerId, clientId, otherClientId] } } });
  });

  beforeEach(async () => {
    emitted = [];
    Object.assign(socket, { emitToUser: (userId: string, event: string, payload: unknown) => emitted.push({ userId, event, payload }) });
    await prisma.clientRequest.deleteMany({ where: { caseId } });
    const now = new Date();
    const row = await prisma.clientRequest.create({
      data: { caseId, clientId, consentVersion: "test", consentAcceptedAt: now, status: "ENGAGED", routedAt: now, engagedAt: now },
    });
    requestId = row.id;
    ({ id: claimId } = await prisma.clientRequestClaim.create({
      data: { requestId, lawyerId, claimedAt: now, expiresAt: new Date(now.getTime() + 86_400_000), quotedAt: now, quoteType: "FIXED_FEE", quoteAmountMinor: 50000, quoteCurrency: "GBP", quoteMessage: "Fixed fee.", outcome: "ENGAGED" },
    }));
  });

  afterEach(() => Object.assign(socket, { emitToUser: realEmit }));

  it("carries a message from the lawyer to the client, live, with who wrote it", async () => {
    const { body } = await lawyer.post({ body: "  Please send me your contract.  " }).expect(201);
    expect(body).to.deep.include({ requestId, claimId, body: "Please send me your contract.", document: null });
    expect(body.author).to.deep.equal({ id: lawyerId, name: "Lena Lawyer", side: "LAWYER" });

    const sent = emitted.find((e) => e.event === "engagement:message");
    expect(sent?.userId).to.equal(clientId);
    expect(sent?.payload).to.deep.equal({ requestId, claimId, message: body });

    const thread = (await client.list().expect(200)).body;
    expect(thread).to.deep.include({ total: 1, unread: 1 });
    expect(thread.data[0].body).to.equal("Please send me your contract.");
  });

  it("lets the client share a document already on the case, and tells the lawyer about it", async () => {
    const { body } = await client.post({ body: "Here it is.", documentId }).expect(201);
    expect(body.author).to.deep.equal({ id: clientId, name: "Clara Client", side: "CLIENT" });
    expect(body.document).to.deep.include({ id: documentId, filename: "Dismissal letter.pdf", submittedBy: { id: clientId, name: "Clara Client" } });

    expect(emitted.filter((e) => e.userId === lawyerId).map((e) => e.event).sort()).to.deep.equal(["engagement:document-added", "engagement:message"]);
    expect(emitted.find((e) => e.event === "engagement:document-added")!.payload).to.deep.include({ requestId, caseId, documentId, filename: "Dismissal letter.pdf" });
  });

  it("shares a document without any text", async () => {
    expect((await client.post({ documentId }).expect(201)).body).to.deep.include({ body: "" });
  });

  it("refuses an empty message, and a document that isn't on the case", async () => {
    await lawyer.post({ body: "   " }).expect(400);
    await client.post({}).expect(400);
    await client.post({ documentId: crypto.randomUUID() }).expect(404);
  });

  it("never lets the lawyer attach a document: the client's case is read-only to them", async () => {
    const { body } = await lawyer.post({ body: "See this", documentId }).expect(201);
    expect(body.document).to.equal(null);
  });

  it("counts what the other side wrote since you last read, and posting or reading clears it", async () => {
    await client.post({ body: "One" }).expect(201);
    await client.post({ body: "Two" }).expect(201);
    expect((await lawyer.list().expect(200)).body.unread).to.equal(2);
    expect((await client.list().expect(200)).body.unread).to.equal(0); // their own messages don't count

    await lawyer.read().expect(204);
    expect((await lawyer.list().expect(200)).body.unread).to.equal(0);

    await client.post({ body: "Three" }).expect(201);
    expect((await lawyer.list().expect(200)).body.unread).to.equal(1);
    await lawyer.post({ body: "Got it" }).expect(201);
    expect((await lawyer.list().expect(200)).body.unread).to.equal(0);
  });

  it("stores the text sealed when field encryption is on, and reads it back", async () => {
    Object.assign(cfg, { FIELD_ENCRYPTION_ENABLED: true, FIELD_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64") });
    try {
      await client.post({ body: "My employer is Acme Ltd." }).expect(201);
      const row = await prisma.engagementMessage.findFirstOrThrow({ where: { requestId } });
      expect(row.body.startsWith("enc1:")).to.equal(true);
      expect(row.body).to.not.include("Acme");
      expect((await lawyer.list().expect(200)).body.data[0].body).to.equal("My employer is Acme Ltd.");
    } finally {
      Object.assign(cfg, { FIELD_ENCRYPTION_ENABLED: savedEncryption.enabled, FIELD_ENCRYPTION_KEY: savedEncryption.key });
    }
  });

  it("stays readable once closed, but read-only (409 ENGAGEMENT_CLOSED)", async () => {
    await lawyer.post({ body: "Before close" }).expect(201);
    await prisma.clientRequest.update({ where: { id: requestId }, data: { status: "CLOSED", closedAt: new Date(), closedBy: "LAWYER" } });
    expect((await client.list().expect(200)).body.total).to.equal(1);
    expect((await lawyer.list().expect(200)).body.total).to.equal(1);
    expect((await client.post({ body: "After" }).expect(409)).body.code).to.equal("ENGAGEMENT_CLOSED");
    expect((await lawyer.post({ body: "After" }).expect(409)).body.code).to.equal("ENGAGEMENT_CLOSED");
  });

  it("is only for the two of them", async () => {
    await lawyer.list(otherLawyerId).expect(404);
    await lawyer.post({ body: "Hi" }, otherLawyerId).expect(404);
    await client.list(otherClientId).expect(404);
    await client.post({ body: "Hi" }, otherClientId).expect(404);
    await request(app).get(`/api/client-requests/${requestId}/messages`).expect(401);
  });

  describe("before hire (phase 5b)", () => {
    const CLIENT = { id: null, name: "Client", side: "CLIENT" };

    it("opens when the lawyer joins: either side writes, and the lawyer sees the client as Client", async () => {
      await beforeHire();
      await lawyer.post({ body: "What date were you dismissed?" }).expect(201);
      const { body } = await client.post({ body: "On 3 March." }, clientId, claimId).expect(201);
      expect(body.author).to.deep.equal(CLIENT);
      expect(emitted.find((e) => e.userId === lawyerId && e.event === "engagement:message")!.payload).to.deep.include({ requestId, claimId });

      const thread = (await lawyer.list().expect(200)).body;
      expect(thread).to.deep.include({ total: 2, unread: 1 });
      expect(thread.data[1].author).to.deep.equal(CLIENT);
      expect((await client.list(clientId, claimId).expect(200)).body).to.deep.include({ total: 2, unread: 0 });
    });

    it("shows the client's name once the lawyer is hired", async () => {
      await beforeHire();
      await client.post({ body: "Hello." }, clientId, claimId).expect(201);
      await prisma.clientRequestClaim.update({ where: { id: claimId }, data: { outcome: "ENGAGED" } });
      await prisma.clientRequest.update({ where: { id: requestId }, data: { status: "ENGAGED", engagedAt: new Date() } });
      expect((await lawyer.list().expect(200)).body.data[0].author).to.deep.equal({ id: clientId, name: "Clara Client", side: "CLIENT" });
    });

    it("is text only: documents wait until the client hires that lawyer", async () => {
      await beforeHire();
      const refused = await client.post({ body: "My letter", documentId }, clientId, claimId).expect(400);
      expect(refused.body.code).to.equal("DOCUMENTS_AFTER_HIRE");
      expect(await prisma.engagementMessage.count({ where: { requestId } })).to.equal(0);
    });

    it("needs the client to name the lawyer: without claimId it's the hired lawyer's, and there's none yet", async () => {
      await beforeHire();
      await client.list().expect(409);
      await client.list(clientId, crypto.randomUUID()).expect(404);
    });

    it("gives each lawyer their own thread, with its own unread count", async () => {
      await beforeHire();
      const other = await prisma.clientRequestClaim.create({ data: { requestId, lawyerId: otherLawyerId, claimedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000) } });
      await client.post({ body: "To Lena" }, clientId, claimId).expect(201);
      await client.post({ body: "To Omar" }, clientId, other.id).expect(201);
      await client.post({ body: "To Omar again" }, clientId, other.id).expect(201);

      const lena = (await lawyer.list().expect(200)).body;
      const omar = (await lawyer.list(otherLawyerId).expect(200)).body;
      expect(lena.data.map((m: { body: string }) => m.body)).to.deep.equal(["To Lena"]);
      expect(omar).to.deep.include({ total: 2, unread: 2 });
      expect(emitted.filter((e) => e.event === "engagement:message").map((e) => e.userId)).to.deep.equal([lawyerId, otherLawyerId, otherLawyerId]);
    });

    it("turns read-only, but readable, once the lawyer's claim ends (409 THREAD_CLOSED)", async () => {
      await beforeHire();
      await lawyer.post({ body: "I can help." }).expect(201);
      await prisma.clientRequestClaim.update({ where: { id: claimId }, data: { outcome: "NOT_CHOSEN", endedAt: new Date() } });

      expect((await lawyer.list().expect(200)).body.total).to.equal(1);
      expect((await client.list(clientId, claimId).expect(200)).body.total).to.equal(1);
      expect((await lawyer.post({ body: "Still there?" }).expect(409)).body.code).to.equal("THREAD_CLOSED");
      expect((await client.post({ body: "Sorry." }, clientId, claimId).expect(409)).body.code).to.equal("THREAD_CLOSED");
    });

    it("is for nobody who never joined", async () => {
      await beforeHire();
      await lawyer.list(otherLawyerId).expect(404);
      await client.list(otherClientId, claimId).expect(404);
    });
  });

  // The engaged lawyer is the claim that ended ENGAGED; looking for an open one found nobody, so a
  // client's new document never reached the lawyer live.
  it("finds the engaged lawyer of a case, for the document-added event", async () => {
    const engaged = await ClientRequestRepo.findEngagedLawyerForCase(caseId);
    expect(engaged).to.deep.include({ requestId, lawyerId });
  });
});
