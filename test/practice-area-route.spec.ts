/** Practice areas (PracticeAreaSvc): the admin's pages per site, the lawyer app's picker, and a
 * lawyer saving their areas, through the real routes against the real database. Works next to the
 * seeded defaults (practice_areas migration): the areas it adds carry a per-run suffix and are
 * removed afterwards, and the UK order is put back. Security audit rows are captured in memory. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after, beforeEach, afterEach } from "mocha";
import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import { ACCESS_TOKEN_SECRET } from "../src/config";
import SecurityAuditRepo from "../src/repositories/security-audit.repository";
import { DEFAULT_PRACTICE_AREAS } from "../src/constants/practice-area.constants";

const tokenFor = (userId: string) => jwt.sign({ userId }, ACCESS_TOKEN_SECRET, { expiresIn: "1h" });

describe("Practice areas", () => {
  const adminId = crypto.randomUUID();
  const lawyerId = crypto.randomUUID();
  const suffix = crypto.randomUUID().slice(0, 8);
  const named = (name: string) => `${name} ${suffix}`;
  let asAdmin: { Authorization: string };
  let asLawyer: { Authorization: string };
  let auditRows: any[];
  let savedAuditCreate: unknown;
  let ukOrder: { id: string; sortOrder: number }[];

  const admin = {
    list: (country: string) => request(app).get(`/api/admin/practice-areas?country=${country}`).set(asAdmin),
    create: (body: object) => request(app).post("/api/admin/practice-areas").set(asAdmin).send(body),
    update: (id: string, body: object) => request(app).patch(`/api/admin/practice-areas/${id}`).set(asAdmin).send(body),
    delete: (id: string) => request(app).delete(`/api/admin/practice-areas/${id}`).set(asAdmin),
    reorder: (body: object) => request(app).post("/api/admin/practice-areas/reorder").set(asAdmin).send(body),
  };
  const picker = (country: string) => request(app).get(`/api/practice-areas?country=${country}`).set(asLawyer);
  const saveProfile = (body: object) => request(app).patch("/api/users/me/client-request-profile").set(asLawyer).send(body);

  before(async () => {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { code: "UK" } });
    await prisma.user.createMany({
      data: [
        { id: adminId, email: `pa-admin-${adminId}@example.com`, username: `pa-admin-${adminId}`, role: "ADMIN" },
        { id: lawyerId, email: `pa-lawyer-${lawyerId}@example.com`, username: `pa-lawyer-${lawyerId}`, role: "LAWYER", tenantId: tenant.id },
      ],
    });
    asAdmin = { Authorization: `Bearer ${tokenFor(adminId)}` };
    asLawyer = { Authorization: `Bearer ${tokenFor(lawyerId)}` };
    ukOrder = await prisma.practiceArea.findMany({ where: { country: "UK" }, select: { id: true, sortOrder: true } });
  });

  after(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [adminId, lawyerId] } } });
    await prisma.practiceArea.deleteMany({ where: { name: { endsWith: suffix } } });
    for (const { id, sortOrder } of ukOrder) await prisma.practiceArea.update({ where: { id }, data: { sortOrder } });
  });

  beforeEach(() => {
    auditRows = [];
    savedAuditCreate = (SecurityAuditRepo as any).create;
    (SecurityAuditRepo as any).create = async (data: object) => {
      auditRows.push(data);
      return { id: "row", createdAt: new Date(), ...data };
    };
  });
  afterEach(() => {
    (SecurityAuditRepo as any).create = savedAuditCreate;
  });

  it("needs an admin", async () => {
    await request(app).get("/api/admin/practice-areas?country=UK").set(asLawyer).expect(403);
  });

  it("starts each site with its defaults, in order, each mapped to one of its site's case areas", async () => {
    const uk = (await admin.list("UK").expect(200)).body;
    const ukDefaults = uk.filter((a: any) => !a.name.endsWith(suffix));
    expect(ukDefaults.map((a: any) => a.name)).to.include.members(DEFAULT_PRACTICE_AREAS.UK.map((a) => a.name));
    expect(ukDefaults.map((a: any) => a.name)).to.not.include.members(["Personal Injury Law", "Medical Negligence"]);
    expect(uk.find((a: any) => a.name === "Employment Law")).to.deep.include({ country: "UK", caseArea: "EMPLOYMENT", isActive: true });
    expect(uk.find((a: any) => a.name === "Immigration Law")).to.deep.include({ caseArea: "IMMIGRATION" });
    expect([...DEFAULT_PRACTICE_AREAS.UK, ...DEFAULT_PRACTICE_AREAS.PH].every((a) => a.caseArea)).to.equal(true);
    expect(uk[0]).to.have.property("lawyerCount");

    const ph = (await admin.list("PH").expect(200)).body;
    expect(ph.map((a: any) => a.name)).to.include.members(DEFAULT_PRACTICE_AREAS.PH.map((a) => a.name));
    expect(ph.find((a: any) => a.name === "Labor and Employment Law")).to.deep.include({ country: "PH", caseArea: "EMPLOYMENT" });
  });

  it("needs a site", async () => {
    await admin.list("US").expect(400);
    await picker("").expect(400);
  });

  it("adds an area at the end of the list, refuses a name the site already has, and audits it", async () => {
    const { body } = await admin.create({ country: "UK", name: named("Sports Law"), caseArea: "OTHER" }).expect(201);
    expect(body).to.deep.include({ country: "UK", name: named("Sports Law"), caseArea: "OTHER", isActive: true, lawyerCount: 0 });
    const list = (await admin.list("UK").expect(200)).body;
    expect(list[list.length - 1].id).to.equal(body.id);
    expect(auditRows.find((r) => r.action === "admin.practice_area.created")).to.deep.include({
      actorId: adminId,
      targetType: "practice_area",
      targetId: `UK:${named("Sports Law")}`,
    });

    const clash = await admin.create({ country: "UK", name: named("sports LAW") }).expect(409);
    expect(clash.body.code).to.equal("PRACTICE_AREA_NAME_TAKEN");
    // The same name is fine on the other site.
    await admin.create({ country: "PH", name: named("Sports Law") }).expect(201);
  });

  it("maps an area only to one of its own site's case areas", async () => {
    // DEBT_INSOLVENCY is UK's; PH has no such case area.
    const res = await admin.create({ country: "PH", name: named("Debt Law"), caseArea: "DEBT_INSOLVENCY" }).expect(400);
    expect(res.body.code).to.equal("UNKNOWN_CASE_AREA");
    await admin.create({ country: "PH", name: named("Shipping Law"), caseArea: "BUSINESS" }).expect(201);
    await admin.create({ country: "UK", name: named("Injury Law"), caseArea: "PERSONAL_INJURY" }).expect(400);
  });

  it("renames, remaps and switches an area off: off hides it from the picker", async () => {
    const { body: created } = await admin.create({ country: "UK", name: named("Media Law") }).expect(201);
    expect((await picker("UK").expect(200)).body.map((a: any) => a.id)).to.include(created.id);

    const { body: renamed } = await admin.update(created.id, { name: named("Media and Entertainment Law"), caseArea: "CONSUMER" }).expect(200);
    expect(renamed).to.deep.include({ name: named("Media and Entertainment Law"), caseArea: "CONSUMER" });
    const audit = auditRows.find((r) => r.action === "admin.practice_area.updated");
    expect(audit.payload.from).to.deep.include({ name: named("Media Law"), caseArea: null });

    await admin.update(created.id, { isActive: false }).expect(200);
    const options = (await picker("UK").expect(200)).body;
    expect(options.map((a: any) => a.id)).to.not.include(created.id);
    expect(Object.keys(options[0]).sort()).to.deep.equal(["id", "name"]);

    expect((await admin.update(created.id, { name: "Employment Law" }).expect(409)).body.code).to.equal("PRACTICE_AREA_NAME_TAKEN");
    await admin.update(crypto.randomUUID(), { isActive: true }).expect(404);
  });

  it("lets a lawyer save areas from their site, keeps a switched-off one they hold, and won't add a new switched-off one", async () => {
    const employment = await prisma.practiceArea.findFirstOrThrow({ where: { country: "UK", name: "Employment Law" } });
    const philippine = await prisma.practiceArea.findFirstOrThrow({ where: { country: "PH", name: "Civil Law" } });
    const { body: held } = await admin.create({ country: "UK", name: named("Held Law") }).expect(201);
    const { body: retired } = await admin.create({ country: "UK", name: named("Retired Law") }).expect(201);

    const { body: saved } = await saveProfile({ practiceAreaIds: [held.id, employment.id] }).expect(200);
    expect(saved.practiceAreas.map((a: any) => a.name)).to.deep.equal(["Employment Law", named("Held Law")]);

    await admin.update(held.id, { isActive: false }).expect(200);
    await admin.update(retired.id, { isActive: false }).expect(200);
    const kept = (await saveProfile({ practiceAreaIds: [employment.id, held.id] }).expect(200)).body;
    expect(kept.practiceAreas).to.deep.include({ id: held.id, name: named("Held Law"), isActive: false });

    expect((await saveProfile({ practiceAreaIds: [employment.id, retired.id] }).expect(400)).body.code).to.equal("PRACTICE_AREA_INACTIVE");
    expect((await saveProfile({ practiceAreaIds: [philippine.id] }).expect(400)).body.code).to.equal("UNKNOWN_PRACTICE_AREA");

    // A rename shows on the lawyer's profile at once.
    await admin.update(held.id, { name: named("Kept Law") }).expect(200);
    const { body: profile } = await request(app).get("/api/users/me/client-request-profile").set(asLawyer).expect(200);
    expect(profile.practiceAreas.map((a: any) => a.name)).to.include(named("Kept Law"));

    // Held by a lawyer: can't be deleted.
    expect((await admin.list("UK").expect(200)).body.find((a: any) => a.id === held.id).lawyerCount).to.equal(1);
    expect((await admin.delete(held.id).expect(409)).body.code).to.equal("PRACTICE_AREA_IN_USE");
  });

  it("deletes an area nobody holds, and audits it", async () => {
    const { body } = await admin.create({ country: "PH", name: named("Spare Law") }).expect(201);
    await admin.delete(body.id).expect(204);
    expect(await prisma.practiceArea.findUnique({ where: { id: body.id } })).to.equal(null);
    expect(auditRows.find((r) => r.action === "admin.practice_area.deleted")).to.deep.include({ targetId: `PH:${named("Spare Law")}` });
    await admin.delete(body.id).expect(404);
  });

  it("reorders a site's areas, given every one of them", async () => {
    const ids = (await admin.list("UK").expect(200)).body.map((a: any) => a.id);
    expect((await admin.reorder({ country: "UK", ids: ids.slice(1) }).expect(400)).body.code).to.equal("PRACTICE_AREA_ORDER_INCOMPLETE");

    const reversed = [...ids].reverse();
    const { body } = await admin.reorder({ country: "UK", ids: reversed }).expect(200);
    expect(body.map((a: any) => a.id)).to.deep.equal(reversed);
    expect((await picker("UK").expect(200)).body[0].id).to.equal((await admin.list("UK")).body.find((a: any) => a.isActive).id);
    expect(auditRows.find((r) => r.action === "admin.practice_area.updated")).to.deep.include({ targetId: "UK" });
  });
});
