/** DataExportSvc — the "export my data" document. The first block needs no database; the second
 * runs against the real one like the organization specs, creating its own rows and removing them. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after } from "mocha";
import { Prisma } from "@prisma/client";
import prisma from "../src/lib/prisma";
import DataExportSvc, { EXPORT_EXCLUDED_MODELS, planExport } from "../src/services/data-export.service";
import OrganizationSvc from "../src/services/organization.service";

const models = Prisma.dmmf.datamodel.models;

describe("planExport (schema coverage)", () => {
  const plan = planExport("user-1");
  const planned = new Set(plan.map((s) => s.model));

  it("includes every table that points at a user, so a new one can't be forgotten", () => {
    const pointsAtUser = models
      .filter((m) => m.name !== "User" && m.fields.some((f) => f.kind === "object" && f.type === "User" && (f.relationFromFields?.length ?? 0) > 0))
      .map((m) => m.name);
    const missing = pointsAtUser.filter((name) => !planned.has(name) && !EXPORT_EXCLUDED_MODELS.has(name));
    expect(missing, `tables pointing at User but missing from the export: ${missing.join(", ")}`).to.deep.equal([]);
  });

  it("only excludes tables that exist", () => {
    const names = new Set(models.map((m) => m.name));
    for (const excluded of EXPORT_EXCLUDED_MODELS) expect(names.has(excluded), `${excluded} is not a model`).to.equal(true);
  });

  it("never exports sessions (credentials)", () => {
    expect(planned.has("Session")).to.equal(false);
  });

  it("limits case tables to cases the user owns", () => {
    const claims = plan.find((s) => s.model === "CaseClaim");
    expect(claims?.where).to.deep.equal({ case: { userId: "user-1" } });
  });

  it("limits a user's audit events to the ones they caused", () => {
    const audit = plan.find((s) => s.model === "AuditEvent");
    expect(audit?.where).to.deep.equal({ actorId: "user-1" });
  });
});

describe("DataExportSvc.stream (real database)", () => {
  const userId = crypto.randomUUID();
  const strangerId = crypto.randomUUID();
  const email = `export-${userId}@example.com`;
  const createdUserIds = [userId, strangerId];
  let ownCaseId = "";
  let strangerCaseId = "";
  let output = "";
  let counts: Record<string, number> = {};

  before(async () => {
    await prisma.user.create({ data: { id: userId, email, username: `export-${userId}`, password: "bcrypt-hash-must-not-leak" } });
    await prisma.user.create({ data: { id: strangerId, email: `export-${strangerId}@example.com`, username: `export-${strangerId}` } });

    const org = await OrganizationSvc.create(userId, "Export Firm", undefined, "PH");
    ownCaseId = (await prisma.case.create({ data: { id: crypto.randomUUID(), userId, organizationId: org.id, caseName: "My Own Case" } })).id;
    strangerCaseId = (await prisma.case.create({ data: { id: crypto.randomUUID(), userId: strangerId, organizationId: org.id, caseName: "Someone Else's Case" } })).id;

    await prisma.consent.create({ data: { userId, purpose: "MARKETING", version: "2026-10", grantedAt: new Date(), source: "settings" } });
    await prisma.session.create({ data: { userId, refreshToken: `refresh-${userId}`, expiresAt: new Date(Date.now() + 3600_000) } });
    await prisma.auditEvent.create({ data: { actorId: userId, action: "auth.login", payload: { method: "password" } } });
    await prisma.auditEvent.create({ data: { actorId: strangerId, action: "auth.login", payload: { method: "password" } } });

    counts = await DataExportSvc.stream(userId, (chunk) => {
      output += chunk;
    });
  });

  after(async () => {
    await prisma.auditEvent.deleteMany({ where: { actorId: { in: createdUserIds } } });
    await prisma.case.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.organizationMember.deleteMany({ where: { userId: { in: createdUserIds } } });
    await prisma.organization.deleteMany({ where: { createdById: { in: createdUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  });

  it("writes one valid JSON document", () => {
    const parsed = JSON.parse(output);
    expect(parsed).to.have.keys(["exportedAt", "user", "data"]);
    expect(parsed.user).to.include({ id: userId, email });
  });

  it("includes the user's own rows and counts them", () => {
    const { data } = JSON.parse(output);
    expect(data.Case.map((c: { id: string }) => c.id)).to.deep.equal([ownCaseId]);
    expect(data.Consent).to.have.length(1);
    expect(data.AuditEvent).to.have.length(1);
    expect(counts.Case).to.equal(1);
  });

  it("leaves out other people's rows", () => {
    expect(output).to.not.include(strangerCaseId);
    expect(output).to.not.include("Someone Else's Case");
  });

  it("leaves out credentials: the password hash, and the whole Session table", () => {
    expect(output).to.not.include("bcrypt-hash-must-not-leak");
    expect(output).to.not.include(`refresh-${userId}`);
    expect(JSON.parse(output).data).to.not.have.property("Session");
  });
});
