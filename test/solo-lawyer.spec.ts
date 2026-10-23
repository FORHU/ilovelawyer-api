/** A solo lawyer has no organization (docs/adr/0022): choosing Solo creates none, their work is
 * stored with organizationId null and their userId, it never reaches another lawyer, and they pay
 * the per-case fee with their own card. Runs the real routes against the real database with its
 * own users, removed afterwards. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after, afterEach } from "mocha";
import request from "supertest";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import loginToken from "../src/utils/loginToken";
import OrganizationSvc from "../src/services/organization.service";
import OrganizationInviteRepo from "../src/repositories/organization-invite.repository";
import OrganizationChargeRepo from "../src/repositories/organization-charge.repository";
import ClientRequestRepo from "../src/repositories/client-request.repository";
import OrganizationChargeSvc from "../src/services/organization-charge.service";
import { setOrganizationCardProvider, dummyOrganizationCardProvider, type CardChargeRequest } from "../src/payments/organization-card-provider";
import { scopeWhere, ownScope } from "../src/utils/workspace";
import { CLIENT_URL } from "../src/config";

const UK = "https://uk.ilovelawyer.com";
const APP_ORIGIN = "http://localhost:3002";

describe("solo lawyers, with no organization", () => {
  const alice = crypto.randomUUID();
  const bob = crypto.randomUUID();
  const firmOwner = crypto.randomUUID();
  const client = crypto.randomUUID();
  const users = [alice, bob, firmOwner, client];
  let firmId: string;
  const savedClientUrl = [...CLIENT_URL];

  const as = (id: string) => ({ Authorization: `Bearer ${loginToken(id, false).accessToken}`, Origin: UK });
  const get = (path: string, id: string, workspace?: string) =>
    request(app)
      .get(path)
      .set({ ...as(id), ...(workspace ? { "X-Organization-Id": workspace } : {}) });
  const post = (path: string, id: string, body: object, workspace?: string) =>
    request(app)
      .post(path)
      .set({ ...as(id), ...(workspace ? { "X-Organization-Id": workspace } : {}) })
      .send(body);

  before(async () => {
    const tenant = await prisma.tenant.upsert({ where: { code: "UK" }, update: {}, create: { code: "UK", name: "United Kingdom" } });
    await prisma.user.createMany({
      data: users.map((id) => ({
        id,
        email: `solo-${id}@example.com`,
        username: `solo-${id}`,
        role: id === client ? ("USER" as const) : ("LAWYER" as const),
        approvalStatus: "ACTIVE" as const,
        isEmailVerified: true,
        tenantId: tenant.id,
      })),
    });
    firmId = (await OrganizationSvc.create(firmOwner, "Solo Spec LLP", undefined, "UK")).id;
    if (!CLIENT_URL.includes(APP_ORIGIN)) CLIENT_URL.push(APP_ORIGIN);
  });

  after(async () => {
    await prisma.event.deleteMany({ where: { userId: { in: users } } });
    await prisma.note.deleteMany({ where: { userId: { in: users } } });
    await prisma.caseCopy.deleteMany({ where: { userId: { in: users } } });
    await prisma.case.deleteMany({ where: { userId: { in: users } } });
    await prisma.userBilling.deleteMany({ where: { userId: { in: users } } });
    await prisma.organizationInvite.deleteMany({ where: { userId: { in: users } } });
    await prisma.organizationMember.deleteMany({ where: { userId: { in: users } } });
    await prisma.organization.deleteMany({ where: { createdById: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    CLIENT_URL.splice(0, CLIENT_URL.length, ...savedClientUrl);
  });

  describe("choosing Solo", () => {
    it("records the choice and creates no organization", async () => {
      const { body } = await post("/api/users/me/solo", alice, {}).expect(200);
      expect(body.soloChosenAt).to.be.a("string");
      await post("/api/users/me/solo", bob, {}).expect(200);
      expect(await prisma.organization.count({ where: { createdById: { in: [alice, bob] } } })).to.equal(0);
      expect(await prisma.organizationMember.count({ where: { userId: { in: [alice, bob] } } })).to.equal(0);
    });

    it("keeps the first date when chosen again", async () => {
      const first = (await prisma.user.findUniqueOrThrow({ where: { id: alice } })).soloChosenAt;
      await post("/api/users/me/solo", alice, {}).expect(200);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: alice } })).soloChosenAt?.getTime()).to.equal(first?.getTime());
    });

    it("is for lawyers only", async () => {
      await post("/api/users/me/solo", client, {}).expect(403);
    });

    it("refuses a personal organization for a lawyer", async () => {
      const { body } = await post("/api/organizations", alice, { name: "Alice", personal: true }).expect(400);
      expect(body.code).to.equal("SOLO_HAS_NO_ORGANIZATION");
    });

    it("gives their own workspace on the account's site as the portfolio", async () => {
      const { body } = await get("/api/organizations/portfolio", alice).expect(200);
      expect(body).to.deep.include({ own: true, tenant: { code: "UK" }, role: "OWNER" });
      expect(body.copies).to.deep.equal([]);
    });
  });

  describe("their work", () => {
    let caseId: string;

    before(async () => {
      await post("/api/my-cases", alice, { caseName: `Alice v Solo ${alice}` }).expect(201);
      caseId = (await prisma.case.findFirstOrThrow({ where: { caseName: `Alice v Solo ${alice}` } })).id;
      await post("/api/notes", alice, { date: "2026-10-23", body: "Alice's own note" }).expect(201);
      await post("/api/events", alice, { title: "Alice's hearing", dateTime: "2030-01-01T10:00:00.000Z" }).expect(201);
    });

    it("is stored with no organization, under the lawyer", async () => {
      const kase = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
      expect(kase).to.deep.include({ organizationId: null, userId: alice });
      expect(await prisma.note.count({ where: { userId: alice, organizationId: null } })).to.equal(1);
      expect(await prisma.event.count({ where: { userId: alice, organizationId: null } })).to.equal(1);
    });

    it("is listed for its lawyer", async () => {
      const cases = await get("/api/my-cases", alice).expect(200);
      expect(cases.body.data.map((c: { id: string }) => c.id)).to.include(caseId);
      await get(`/api/my-cases/${caseId}`, alice).expect(200);
    });

    it("never reaches another solo lawyer", async () => {
      const cases = await get("/api/my-cases", bob).expect(200);
      expect(cases.body.data.map((c: { id: string }) => c.id)).to.not.include(caseId);
      await get(`/api/my-cases/${caseId}`, bob).expect(404);
      const notes = await get("/api/notes", bob).expect(200);
      expect(JSON.stringify(notes.body)).to.not.include("Alice's own note");
      const events = await get("/api/events", bob).expect(200);
      expect(events.body.events.map((e: { title: string }) => e.title)).to.not.include("Alice's hearing");
    });

    it("never reaches a firm's lawyer, from the firm or their own workspace", async () => {
      const fromFirm = await get("/api/my-cases", firmOwner, firmId).expect(200);
      expect(fromFirm.body.data.map((c: { id: string }) => c.id)).to.not.include(caseId);
      const fromOwn = await get("/api/my-cases", firmOwner).expect(200);
      expect(fromOwn.body.data.map((c: { id: string }) => c.id)).to.not.include(caseId);
    });

    it("can't be opened as someone else's workspace without a share", async () => {
      await get("/api/my-cases", bob, `user:${alice}`).expect(403);
    });

    it("is scoped by owner, never by a missing organization alone", () => {
      expect(scopeWhere(ownScope(alice))).to.deep.equal({ organizationId: null, userId: alice });
      expect(() => scopeWhere({ organizationId: null, ownerId: null })).to.throw();
    });
  });

  describe("leaving a firm", () => {
    it("copies their cases to their own workspace and leaves them solo", async () => {
      const member = crypto.randomUUID();
      users.push(member);
      await prisma.user.create({
        data: { id: member, email: `solo-${member}@example.com`, username: `solo-${member}`, role: "LAWYER", approvalStatus: "ACTIVE" },
      });
      await OrganizationInviteRepo.create(firmId, member, "MEMBER");
      await OrganizationSvc.acceptInvite(firmId, member);
      const firmCase = await prisma.case.create({ data: { caseName: `Firm case ${member}`, userId: member, organizationId: firmId } });

      await OrganizationSvc.leave(firmId, member);

      const copy = await prisma.caseCopy.findFirstOrThrow({ where: { sourceCaseId: firmCase.id } });
      expect(copy).to.deep.include({ userId: member, targetOrganizationId: null });
      expect((await prisma.user.findUniqueOrThrow({ where: { id: member } })).soloChosenAt).to.be.instanceOf(Date);
      expect(await prisma.organization.count({ where: { createdById: member } })).to.equal(0);
    });
  });

  describe("the per-case fee", () => {
    const stash = {
      findById: OrganizationChargeRepo.findById,
      failWithoutAttempt: OrganizationChargeRepo.failWithoutAttempt,
      startAttempt: OrganizationChargeRepo.startAttempt,
      settle: OrganizationChargeRepo.settle,
      findForLawyer: ClientRequestRepo.findForLawyer,
    };
    const charge = { id: "charge-1", kind: "PER_CASE_FEE", requestId: "request-1", organizationId: null, lawyerId: alice, amountMinor: 5000, currency: "GBP", failureReason: null };
    let failedWith: string | null;
    let charged: CardChargeRequest[];

    before(() => {
      Object.assign(OrganizationChargeRepo, {
        findById: async () => charge,
        failWithoutAttempt: async (_id: string, reason: string) => void (failedWith = reason),
        startAttempt: async () => 1,
        settle: async () => ({ settled: true, engaged: false }),
      });
      Object.assign(ClientRequestRepo, { findForLawyer: async () => null });
      setOrganizationCardProvider({
        ...dummyOrganizationCardProvider,
        async charge(req: CardChargeRequest) {
          charged.push(req);
          return dummyOrganizationCardProvider.charge(req);
        },
      });
    });

    after(() => {
      Object.assign(OrganizationChargeRepo, { findById: stash.findById, failWithoutAttempt: stash.failWithoutAttempt, startAttempt: stash.startAttempt, settle: stash.settle });
      Object.assign(ClientRequestRepo, { findForLawyer: stash.findForLawyer });
      setOrganizationCardProvider(null);
    });

    afterEach(async () => {
      failedWith = null;
      charged = [];
      await prisma.userBilling.deleteMany({ where: { userId: alice } });
    });

    it("fails with no card, pointing the lawyer to their own billing settings", async () => {
      failedWith = null;
      charged = [];
      expect(await OrganizationChargeSvc.attempt(charge.id)).to.equal("FAILED");
      expect(failedWith).to.match(/your profile/);
    });

    it("is charged to the lawyer's own card", async () => {
      await post("/api/users/me/billing/card/setup-session", alice, { returnUrl: `${APP_ORIGIN}/homepage/profile` }).expect(200);
      const card = await prisma.userBilling.findUniqueOrThrow({ where: { userId: alice } });
      expect(await OrganizationChargeSvc.attempt(charge.id)).to.equal("SUCCEEDED");
      expect(charged).to.have.length(1);
      expect(charged[0]).to.deep.include({ paymentMethodId: card.paymentMethodId });
      expect(charged[0]!.metadata).to.deep.equal({ lawyerId: alice, requestId: "request-1" });
    });

    it("shows the lawyer their own card", async () => {
      await get("/api/users/me/billing/card", alice).expect(200).expect((res) => expect(res.body).to.equal(null));
      await post("/api/users/me/billing/card/setup-session", alice, { returnUrl: `${APP_ORIGIN}/homepage/profile` }).expect(200);
      const { body } = await get("/api/users/me/billing/card", alice).expect(200);
      expect(body).to.deep.include({ brand: "visa", last4: "4242", provider: "DUMMY" });
    });
  });
  describe("undoing a firm during account setup", () => {
    const founder = async () => {
      const id = crypto.randomUUID();
      users.push(id);
      await prisma.user.create({
        data: { id, email: `solo-${id}@example.com`, username: `solo-${id}`, role: "LAWYER", approvalStatus: "ACTIVE", tenant: { connect: { code: "UK" } } },
      });
      const firm = await OrganizationSvc.create(id, `Undo ${id}`, undefined, "UK");
      return { id, firmId: firm.id };
    };

    it("deletes the empty firm outright, with its invites, and leaves no organization", async () => {
      const { id, firmId: undoId } = await founder();
      await OrganizationInviteRepo.create(undoId, bob, "MEMBER");

      await post(`/api/organizations/${undoId}/discard`, id, {}).expect(204);

      expect(await prisma.organization.count({ where: { id: undoId } })).to.equal(0);
      expect(await prisma.organizationInvite.count({ where: { organizationId: undoId } })).to.equal(0);
      expect(await prisma.organizationMember.count({ where: { userId: id } })).to.equal(0);
    });

    it("is only during setup", async () => {
      const { id, firmId: undoId } = await founder();
      await prisma.user.update({ where: { id }, data: { setupCompletedAt: new Date() } });
      const { body } = await post(`/api/organizations/${undoId}/discard`, id, {}).expect(409);
      expect(body.code).to.equal("SETUP_FINISHED");
    });

    it("refuses once someone joined or work was made in it", async () => {
      const joined = await founder();
      await prisma.organizationMember.create({ data: { organizationId: joined.firmId, userId: bob, role: "MEMBER", status: "ACCEPTED" } });
      expect((await post(`/api/organizations/${joined.firmId}/discard`, joined.id, {}).expect(409)).body.code).to.equal("FIRM_HAS_MEMBERS");
      await prisma.organizationMember.deleteMany({ where: { organizationId: joined.firmId, userId: bob } });

      const worked = await founder();
      await prisma.case.create({ data: { caseName: `Undo case ${worked.id}`, userId: worked.id, organizationId: worked.firmId } });
      expect((await post(`/api/organizations/${worked.firmId}/discard`, worked.id, {}).expect(409)).body.code).to.equal("FIRM_HAS_WORK");
    });

    it("is for the firm's owner only", async () => {
      await post(`/api/organizations/${firmId}/discard`, bob, {}).expect(403);
    });
  });
});
