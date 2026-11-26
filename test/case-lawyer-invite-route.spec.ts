/** The client-invites-own-lawyer HTTP surface: GET/POST /api/client/lawyer-invites (authenticated,
 * delegating straight to CaseLawyerInviteSvc) and the public GET /api/case-lawyer-invites/:token the
 * signup page reads with no session at all. Against the real database, like
 * client-request-confirm-route.spec.ts. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after, beforeEach, afterEach } from "mocha";
import request from "supertest";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import loginToken from "../src/utils/loginToken";

describe("case-lawyer-invite routes", function () {
  this.timeout(20_000);
  const clientId = crypto.randomUUID();
  const otherClientId = crypto.randomUUID();
  const caseId = crypto.randomUUID();

  const auth = (id: string) => ({ Authorization: `Bearer ${loginToken(id, false).accessToken}` });
  const getCurrent = (id = clientId, qs = `caseId=${caseId}`) => request(app).get(`/api/client/lawyer-invites?${qs}`).set(auth(id));
  const createLink = (id = clientId, body: object = { caseId }) => request(app).post("/api/client/lawyer-invites/link").set(auth(id)).send(body);
  const createEmail = (id = clientId, body: object = { caseId, email: "lawyer@example.com" }) => request(app).post("/api/client/lawyer-invites/email").set(auth(id)).send(body);
  const revoke = (id = clientId, body: object = { caseId }) => request(app).post("/api/client/lawyer-invites/revoke").set(auth(id)).send(body);
  const lookup = (token: string) => request(app).get(`/api/case-lawyer-invites/${token}`);

  before(async () => {
    await prisma.user.createMany({
      data: [
        { id: clientId, email: `invite-route-${clientId}@example.com`, username: `invite-route-${clientId}`, name: "Jane Smith" },
        { id: otherClientId, email: `invite-route-other-${otherClientId}@example.com`, username: `invite-route-other-${otherClientId}` },
      ],
    });
    await prisma.case.create({ data: { id: caseId, userId: clientId, caseName: "Unfair dismissal", caseAreas: ["EMPLOYMENT"], ukJurisdiction: "England and Wales" } });
  });

  after(async () => {
    await prisma.caseLawyerInvite.deleteMany({ where: { caseId } });
    await prisma.case.deleteMany({ where: { id: caseId } });
    await prisma.user.deleteMany({ where: { id: { in: [clientId, otherClientId] } } });
  });

  afterEach(async () => {
    await prisma.caseLawyerInvite.deleteMany({ where: { caseId } });
  });

  describe("POST /lawyer-invites/link", () => {
    it("returns a token and expiresAt for the caller's own case", async () => {
      const { body } = await createLink().expect(201);
      expect(body.token).to.be.a("string");
      expect(new Date(body.expiresAt).getTime()).to.be.greaterThan(Date.now());
    });

    it("404s for a case the caller doesn't own", async () => {
      await createLink(otherClientId).expect(404);
    });

    it("400s without a caseId", async () => {
      await createLink(clientId, {}).expect(400);
    });
  });

  describe("POST /lawyer-invites/email", () => {
    it("returns a token and stores the email", async () => {
      const { body } = await createEmail().expect(201);
      expect(body.token).to.be.a("string");
      const current = (await getCurrent().expect(200)).body;
      expect(current.email).to.equal("lawyer@example.com");
    });

    it("400s with an invalid email", async () => {
      await createEmail(clientId, { caseId, email: "not-an-email" }).expect(400);
    });

    it("404s for a case the caller doesn't own", async () => {
      await createEmail(otherClientId).expect(404);
    });
  });

  describe("GET /lawyer-invites", () => {
    it("returns null when there is no invite", async () => {
      const { body } = await getCurrent().expect(200);
      expect(body).to.equal(null);
    });

    it("returns the current invite's status for the caller's own case", async () => {
      await createLink().expect(201);
      const { body } = await getCurrent().expect(200);
      expect(body.status).to.equal("PENDING");
    });

    it("404s for a case the caller doesn't own", async () => {
      await getCurrent(otherClientId).expect(404);
    });
  });

  describe("POST /lawyer-invites/revoke", () => {
    it("revokes the pending invite", async () => {
      const { body: created } = await createLink().expect(201);
      await revoke().expect(204);
      // getCurrentForCase only ever sees a PENDING row, so read the row itself to see the revoke.
      const row = await prisma.caseLawyerInvite.findFirstOrThrow({ where: { caseId, token: created.token } });
      expect(row.status).to.equal("REVOKED");
      expect((await getCurrent().expect(200)).body).to.equal(null);
    });

    it("404s when there is nothing to revoke", async () => {
      await revoke().expect(404);
    });

    it("404s for a case the caller doesn't own", async () => {
      await createLink().expect(201);
      await revoke(otherClientId).expect(404);
    });
  });

  describe("GET /api/case-lawyer-invites/:token", () => {
    it("requires no auth and returns the lookup DTO", async () => {
      const { body: created } = await createLink().expect(201);
      const { body } = await lookup(created.token).expect(200);
      expect(body).to.deep.equal({ status: "valid", clientFirstName: "Jane", caseName: "Unfair dismissal", email: null });
    });

    it("404s for an unknown token", async () => {
      await lookup("not-a-real-token").expect(404);
    });

    it("is reachable with no Authorization header at all", async () => {
      const { body: created } = await createLink().expect(201);
      await request(app).get(`/api/case-lawyer-invites/${created.token}`).expect(200);
    });
  });
});
