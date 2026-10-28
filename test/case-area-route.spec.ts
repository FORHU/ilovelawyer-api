/** Client case types (CaseAreaSvc): the admin's page, through the real routes against the real
 * database. Works next to the seeded defaults (case_areas migration): the areas it adds carry a
 * per-run code and name suffix and are removed afterwards, and the UK order is put back. Security
 * audit rows are captured in memory. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after, beforeEach, afterEach } from "mocha";
import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import { ACCESS_TOKEN_SECRET } from "../src/config";
import SecurityAuditRepo from "../src/repositories/security-audit.repository";
import CaseAreaSvc from "../src/services/case-area.service";
import { DEFAULT_CASE_AREAS } from "../src/constants/case-area.constants";

const tokenFor = (userId: string) => jwt.sign({ userId }, ACCESS_TOKEN_SECRET, { expiresIn: "1h" });

describe("Client case types", () => {
  const adminId = crypto.randomUUID();
  const lawyerId = crypto.randomUUID();
  const suffix = crypto.randomUUID().slice(0, 6).toUpperCase().replace(/[^A-Z0-9]/g, "X");
  const code = (base: string) => `${base}_${suffix}`;
  const named = (name: string) => `${name} ${suffix}`;
  let asAdmin: { Authorization: string };
  let auditRows: any[];
  let savedAuditCreate: unknown;
  let ukOrder: { id: string; sortOrder: number }[];

  const admin = {
    list: () => request(app).get("/api/admin/case-areas?country=UK").set(asAdmin),
    create: (body: object) => request(app).post("/api/admin/case-areas").set(asAdmin).send({ country: "UK", description: "Test area.", ...body }),
    update: (id: string, body: object) => request(app).patch(`/api/admin/case-areas/${id}`).set(asAdmin).send(body),
    delete: (id: string) => request(app).delete(`/api/admin/case-areas/${id}`).set(asAdmin),
    reorder: (ids: string[]) => request(app).post("/api/admin/case-areas/reorder").set(asAdmin).send({ country: "UK", ids }),
  };
  const byCode = async (c: string) => ((await admin.list().expect(200)).body as any[]).find((a) => a.code === c);

  before(async () => {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { code: "UK" } });
    await prisma.user.createMany({
      data: [
        { id: adminId, email: `ca-admin-${adminId}@example.com`, username: `ca-admin-${adminId}`, role: "ADMIN" },
        { id: lawyerId, email: `ca-lawyer-${lawyerId}@example.com`, username: `ca-lawyer-${lawyerId}`, role: "LAWYER", tenantId: tenant.id },
      ],
    });
    asAdmin = { Authorization: `Bearer ${tokenFor(adminId)}` };
    ukOrder = await prisma.caseArea.findMany({ where: { country: "UK" }, select: { id: true, sortOrder: true } });
  });

  after(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [adminId, lawyerId] } } });
    await prisma.practiceArea.deleteMany({ where: { name: { endsWith: suffix } } });
    await prisma.case.deleteMany({ where: { caseName: { endsWith: suffix } } });
    await prisma.caseArea.deleteMany({ where: { code: { endsWith: suffix } } });
    for (const { id, sortOrder } of ukOrder) await prisma.caseArea.update({ where: { id }, data: { sortOrder } });
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
    await request(app).get("/api/admin/case-areas?country=UK").set({ Authorization: `Bearer ${tokenFor(lawyerId)}` }).expect(403);
  });

  it("starts with the defaults, described for Jev, and counts what uses each", async () => {
    const list = (await admin.list().expect(200)).body as any[];
    expect(list.map((a) => a.code)).to.include.members(DEFAULT_CASE_AREAS.UK.map((a) => a.code));
    const employment = list.find((a) => a.code === "EMPLOYMENT");
    expect(employment).to.deep.include({ name: "Employment", isActive: true });
    expect(employment.description).to.include("dismissal");
    expect(employment.practiceAreaCount).to.be.greaterThan(0);
    expect(employment).to.have.property("caseCount");
  });

  it("keeps PH's own list, counting only PH's practice areas and no cases", async () => {
    const ph = (await request(app).get("/api/admin/case-areas?country=PH").set(asAdmin).expect(200)).body as any[];
    expect(ph.map((a) => a.code)).to.include.members(DEFAULT_CASE_AREAS.PH.map((a) => a.code));
    const other = ph.find((a) => a.code === "OTHER");
    const phMappedToOther = await prisma.practiceArea.count({ where: { country: "PH", caseArea: "OTHER" } });
    expect(other).to.deep.include({ country: "PH", caseCount: 0, practiceAreaCount: phMappedToOther });
  });

  it("adds an area with an upper-cased code at the end, audited, and refuses a clash or a bad code", async () => {
    const { body } = await admin.create({ code: code("housing").toLowerCase(), name: named("Housing") }).expect(201);
    expect(body).to.deep.include({ code: code("HOUSING"), name: named("Housing"), isActive: true, caseCount: 0, practiceAreaCount: 0 });
    const list = (await admin.list().expect(200)).body as any[];
    expect(list[list.length - 1].id).to.equal(body.id);
    expect(auditRows.find((r) => r.action === "admin.case_area.created")).to.deep.include({ actorId: adminId, targetType: "case_area", targetId: `UK:${code("HOUSING")}` });

    expect((await admin.create({ code: code("HOUSING"), name: named("Other housing") }).expect(409)).body.code).to.equal("CASE_AREA_CODE_TAKEN");
    expect((await admin.create({ code: code("HOMES"), name: named("housing") }).expect(409)).body.code).to.equal("CASE_AREA_NAME_TAKEN");
    expect((await admin.create({ code: "PERSONAL_INJURY", name: named("Injury") }).expect(400)).body.code).to.equal("CASE_AREA_CODE_INVALID");
    expect((await admin.create({ code: "1BAD-CODE", name: named("Bad") }).expect(400)).body.code).to.equal("CASE_AREA_CODE_INVALID");
    await admin.create({ code: code("NODESC"), name: named("No description"), description: "" }).expect(400);
  });

  it("renames, redescribes and switches an area off: off hides it from the client's picker and from Jev", async () => {
    const { body: created } = await admin.create({ code: code("TRAVEL"), name: named("Travel") }).expect(201);
    expect((await CaseAreaSvc.listActive()).map((a) => a.code)).to.include(created.code);

    const { body: renamed } = await admin.update(created.id, { name: named("Travel and holidays"), description: "Flights, package holidays." }).expect(200);
    expect(renamed).to.deep.include({ code: code("TRAVEL"), name: named("Travel and holidays"), description: "Flights, package holidays." });
    expect(auditRows.find((r) => r.action === "admin.case_area.updated").payload.from).to.deep.include({ name: named("Travel") });

    await admin.update(created.id, { isActive: false }).expect(200);
    expect((await CaseAreaSvc.listActive()).map((a) => a.code)).to.not.include(created.code);
    expect((await CaseAreaSvc.forJev()).map((a) => a.code)).to.not.include(created.code);
    // The code is fixed: a patch can't carry one.
    await admin.update(created.id, { code: "NEW" }).expect(400);
  });

  it("never switches off or deletes Other", async () => {
    const other = await byCode("OTHER");
    expect((await admin.update(other.id, { isActive: false }).expect(409)).body.code).to.equal("CASE_AREA_REQUIRED_OTHER");
    expect((await admin.delete(other.id).expect(409)).body.code).to.equal("CASE_AREA_REQUIRED_OTHER");
    await admin.update(other.id, { name: "Other" }).expect(200);
  });

  it("deletes only an area no case has and no practice area maps to", async () => {
    const { body: mapped } = await admin.create({ code: code("MAPPED"), name: named("Mapped") }).expect(201);
    await prisma.practiceArea.create({ data: { country: "UK", name: named("Mapped Law"), caseArea: mapped.code } });
    expect((await admin.delete(mapped.id).expect(409)).body).to.deep.include({ code: "CASE_AREA_IN_USE", practiceAreas: 1 });

    const { body: used } = await admin.create({ code: code("USED"), name: named("Used") }).expect(201);
    await prisma.case.create({ data: { userId: adminId, caseName: named("A case"), caseAreas: [used.code] } });
    expect((await byCode(used.code)).caseCount).to.equal(1);
    expect((await admin.delete(used.id).expect(409)).body).to.deep.include({ code: "CASE_AREA_IN_USE", cases: 1 });

    const { body: spare } = await admin.create({ code: code("SPARE"), name: named("Spare") }).expect(201);
    await admin.delete(spare.id).expect(204);
    expect(auditRows.find((r) => r.action === "admin.case_area.deleted")).to.deep.include({ targetId: `UK:${code("SPARE")}` });
    await admin.delete(spare.id).expect(404);
  });

  it("only lets a UK practice area map to a case area that exists", async () => {
    const res = await request(app).post("/api/admin/practice-areas").set(asAdmin).send({ country: "UK", name: named("Nowhere Law"), caseArea: "NOT_A_CASE_AREA" }).expect(400);
    expect(res.body.code).to.equal("UNKNOWN_CASE_AREA");
    await request(app).post("/api/admin/practice-areas").set(asAdmin).send({ country: "UK", name: named("Holiday Law"), caseArea: code("TRAVEL") }).expect(201);
  });

  it("reorders the areas, given every one of them", async () => {
    const ids = ((await admin.list().expect(200)).body as any[]).map((a) => a.id);
    expect((await admin.reorder(ids.slice(1)).expect(400)).body.code).to.equal("CASE_AREA_ORDER_INCOMPLETE");
    const reversed = [...ids].reverse();
    expect(((await admin.reorder(reversed).expect(200)).body as any[]).map((a) => a.id)).to.deep.equal(reversed);
  });
});
