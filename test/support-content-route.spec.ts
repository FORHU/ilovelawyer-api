/** Support Chat content (SupportContentSvc): the admin's draft, publish, versions and rollback, and
 * what clients and visitors read, through the real routes against the real database. The content
 * is one shared record, so the run notes the published version and the draft it started with and
 * puts them back. Security audit rows are captured in memory. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after, beforeEach, afterEach } from "mocha";
import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import { ACCESS_TOKEN_SECRET } from "../src/config";
import SecurityAuditRepo from "../src/repositories/security-audit.repository";
import SupportContentSvc from "../src/services/support-content.service";
import { SUPPORT_ACTIONS, SUPPORT_ACTION_KEYS } from "../src/constants/support-actions.constants";
import type { SupportContent } from "../src/types/support-content";

const tokenFor = (userId: string) => jwt.sign({ userId }, ACCESS_TOKEN_SECRET, { expiresIn: "1h" });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe("Support Chat content", () => {
  const adminId = crypto.randomUUID();
  const clientId = crypto.randomUUID();
  const lawyerId = crypto.randomUUID();
  const mark = crypto.randomUUID().slice(0, 8);
  let asAdmin: { Authorization: string };
  let asClient: { Authorization: string };
  let asLawyer: { Authorization: string };
  let auditRows: any[];
  let savedAuditCreate: unknown;
  let baseVersion: number;
  let baseContent: SupportContent;
  let savedDraft: Awaited<ReturnType<typeof prisma.supportContentDraft.findUnique>>;

  const api = {
    draft: () => request(app).get("/api/admin/support/content/draft").set(asAdmin),
    save: (content: unknown, expectedUpdatedAt: unknown) => request(app).put("/api/admin/support/content/draft").set(asAdmin).send({ content, expectedUpdatedAt }),
    validate: () => request(app).post("/api/admin/support/content/draft/validate").set(asAdmin),
    publish: () => request(app).post("/api/admin/support/content/publish").set(asAdmin),
    versions: () => request(app).get("/api/admin/support/content/versions").set(asAdmin),
    version: (n: number) => request(app).get(`/api/admin/support/content/versions/${n}`).set(asAdmin),
    rollback: (n: number) => request(app).post(`/api/admin/support/content/versions/${n}/rollback`).set(asAdmin),
    clientContent: () => request(app).get("/api/client/support/content").set(asClient),
    publicContent: () => request(app).get("/api/support/content"),
  };

  /** Saves a changed copy of the current draft and returns the body the API answered with. */
  async function saveEdited(edit: (content: SupportContent) => void) {
    const current = (await api.draft().expect(200)).body;
    const content = clone(current.content) as SupportContent;
    edit(content);
    return (await api.save(content, current.updatedAt).expect(200)).body;
  }

  before(async () => {
    await prisma.user.createMany({
      data: [
        { id: adminId, email: `sc-admin-${adminId}@example.com`, username: `sc-admin-${adminId}`, role: "ADMIN" },
        { id: clientId, email: `sc-client-${clientId}@example.com`, username: `sc-client-${clientId}`, role: "USER" },
        { id: lawyerId, email: `sc-lawyer-${lawyerId}@example.com`, username: `sc-lawyer-${lawyerId}`, role: "LAWYER" },
      ],
    });
    asAdmin = { Authorization: `Bearer ${tokenFor(adminId)}` };
    asClient = { Authorization: `Bearer ${tokenFor(clientId)}` };
    asLawyer = { Authorization: `Bearer ${tokenFor(lawyerId)}` };

    await SupportContentSvc.ensureSeeded();
    const latest = await prisma.supportContentVersion.findFirstOrThrow({ orderBy: { version: "desc" } });
    baseVersion = latest.version;
    baseContent = latest.content as unknown as SupportContent;
    savedDraft = await prisma.supportContentDraft.findUnique({ where: { id: "default" } });
    await prisma.supportContentDraft.upsert({
      where: { id: "default" },
      create: { id: "default", content: latest.content as object, basedOnVersion: baseVersion },
      update: { content: latest.content as object, basedOnVersion: baseVersion },
    });
  });

  after(async () => {
    await prisma.supportContentVersion.deleteMany({ where: { version: { gt: baseVersion } } });
    if (savedDraft) {
      await prisma.supportContentDraft.update({
        where: { id: "default" },
        data: { content: savedDraft.content as object, basedOnVersion: savedDraft.basedOnVersion, updatedById: savedDraft.updatedById, updatedAt: savedDraft.updatedAt },
      });
    } else {
      await prisma.supportContentDraft.deleteMany({ where: { id: "default" } });
    }
    await prisma.user.deleteMany({ where: { id: { in: [adminId, clientId, lawyerId] } } });
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

  it("answers 403 on every admin endpoint to anyone who isn't an admin, and 401 to nobody", async () => {
    const routes: [string, string][] = [
      ["get", "/api/admin/support/content/draft"],
      ["put", "/api/admin/support/content/draft"],
      ["post", "/api/admin/support/content/draft/validate"],
      ["post", "/api/admin/support/content/publish"],
      ["get", "/api/admin/support/content/versions"],
      ["get", "/api/admin/support/content/versions/1"],
      ["post", "/api/admin/support/content/versions/1/rollback"],
      ["get", "/api/admin/support/actions"],
    ];
    for (const [method, path] of routes) {
      for (const who of [asClient, asLawyer]) await (request(app) as any)[method](path).set(who).send({}).expect(403);
      await (request(app) as any)[method](path).send({}).expect(401);
    }
  });

  it("serves the seed content on a fresh database, to clients and to visitors", async () => {
    const signedIn = (await api.clientContent().expect(200)).body;
    expect(signedIn.version).to.be.a("number");
    expect(signedIn.menu.map((c: any) => c.title)).to.include.members(["Getting started", "Credits & payments", "My lawyer request", "Account & sign-in", "Report an issue"]);
    expect(signedIn.settings.assistantName).to.be.a("string");
    expect(signedIn.actions.map((a: any) => a.key)).to.include("DELETE_MY_ACCOUNT");
    expect(signedIn.actions.find((a: any) => a.key === "DELETE_MY_ACCOUNT").safetyCopy).to.have.length(3);

    const signedOut = (await api.publicContent().expect(200)).body;
    expect(signedOut.menu).to.have.length.greaterThan(0);
    expect(signedOut.menu.map((c: any) => c.flowId).every((id: string) => signedOut.flows[id])).to.equal(true);
  });

  it("keeps the client endpoint for client accounts only", async () => {
    await api.clientContent().expect(200);
    await request(app).get("/api/client/support/content").set(asLawyer).expect(403);
    await request(app).get("/api/client/support/content").expect(401);
  });

  it("serves visitors without a session, cacheable, with no account-reading action anywhere", async () => {
    const res = await api.publicContent().expect(200);
    expect(res.headers["cache-control"]).to.include("public");
    const readsAccount = SUPPORT_ACTION_KEYS.filter((k) => SUPPORT_ACTIONS[k].readsAccount);
    for (const key of readsAccount) expect(res.body.actions.map((a: any) => a.key)).to.not.include(key);
    for (const flow of Object.values<any>(res.body.flows)) {
      expect(flow.audience).to.not.equal("SIGNED_IN");
      for (const step of Object.values<any>(flow.steps)) {
        if (step.type === "ACTION") expect(readsAccount).to.not.include(step.actionKey);
      }
    }
    expect(JSON.stringify(res.body)).to.not.include("DELETE_MY_ACCOUNT");
  });

  it("starts with a draft that matches what's published", async () => {
    const { body } = await api.draft().expect(200);
    expect(body.hasUnpublishedChanges).to.equal(false);
    expect(body.currentVersion).to.equal(baseVersion);
    expect(body.content).to.deep.equal(baseContent);
  });

  it("lists the action catalog for the editor", async () => {
    const { body } = await request(app).get("/api/admin/support/actions").set(asAdmin).expect(200);
    expect(body.map((a: any) => a.key)).to.have.members([...SUPPORT_ACTION_KEYS]);
    expect(body.find((a: any) => a.key === "SHOW_CREDITS")).to.deep.include({ audience: "IN", readsAccount: true });
  });

  it("never shows clients a draft edit before Publish, and audits the save", async () => {
    const before = (await api.clientContent().expect(200)).body;
    const saved = await saveEdited((c) => {
      c.settings.greeting = `Hello {firstName} (${mark})`;
    });
    expect(saved.hasUnpublishedChanges).to.equal(true);
    expect(saved.content.settings.greeting).to.equal(`Hello {firstName} (${mark})`);
    expect(auditRows.find((r) => r.action === "admin.support_content.draft_updated")).to.deep.include({ actorId: adminId, targetType: "support_content" });

    const after = (await api.clientContent().expect(200)).body;
    expect(after.settings.greeting).to.equal(before.settings.greeting);
    expect(after.version).to.equal(before.version);
    expect((await api.publicContent().expect(200)).body.settings.greeting).to.equal(before.settings.greeting);
  });

  it("refuses a save made on a stale draft (DRAFT_CONFLICT) and one with the wrong shape", async () => {
    const current = (await api.draft().expect(200)).body;
    const stale = new Date(new Date(current.updatedAt).getTime() - 60_000).toISOString();
    const conflict = await api.save(current.content, stale).expect(409);
    expect(conflict.body.code).to.equal("DRAFT_CONFLICT");

    const broken = clone(current.content);
    broken.flows = "nope";
    await api.save(broken, current.updatedAt).expect(400);
    await api.save(current.content, "not a date").expect(400);
  });

  it("refuses to publish invalid content, with the list of problems, and shows them on validate", async () => {
    const original = (await api.draft().expect(200)).body.content as SupportContent;
    await saveEdited((c) => {
      c.menus.SIGNED_IN[0].flowId = "does-not-exist";
      c.settings.greeting = "Hi {surname}";
    });

    const check = (await api.validate().expect(200)).body;
    expect(check.valid).to.equal(false);
    expect(check.problems.map((p: any) => p.code)).to.include.members(["MENU_FLOW_MISSING", "UNKNOWN_PLACEHOLDER"]);

    const res = await api.publish().expect(422);
    expect(res.body.code).to.equal("SUPPORT_CONTENT_INVALID");
    expect(res.body.problems.map((p: any) => p.code)).to.include("MENU_FLOW_MISSING");
    expect(auditRows.some((r) => r.action === "admin.support_content.published")).to.equal(false);
    expect((await api.clientContent().expect(200)).body.version).to.equal(baseVersion);

    await saveEdited((c) => Object.assign(c, clone(original)));
  });

  it("publishes the draft as the next version, audited, and clients then see it", async () => {
    await saveEdited((c) => {
      c.settings.greeting = `Hello {firstName} (${mark})`;
    });
    expect((await api.validate().expect(200)).body).to.deep.equal({ valid: true, problems: [] });

    const published = (await api.publish().expect(201)).body;
    expect(published.version).to.equal(baseVersion + 1);
    expect(auditRows.find((r) => r.action === "admin.support_content.published")).to.deep.include({ actorId: adminId, targetType: "support_content", targetId: String(baseVersion + 1) });

    const seen = (await api.clientContent().expect(200)).body;
    expect(seen.version).to.equal(baseVersion + 1);
    expect(seen.settings.greeting).to.equal(`Hello {firstName} (${mark})`);
    expect((await api.publicContent().expect(200)).body.settings.greeting).to.equal(`Hello {firstName} (${mark})`);

    const draft = (await api.draft().expect(200)).body;
    expect(draft.hasUnpublishedChanges).to.equal(false);
    expect(draft.basedOnVersion).to.equal(baseVersion + 1);
  });

  it("refuses to publish a draft that matches what's published", async () => {
    const res = await api.publish().expect(409);
    expect(res.body.code).to.equal("NO_CHANGES");
  });

  it("won't publish over a draft that was saved while it was being published, and publishes nothing", async () => {
    const edited = await saveEdited((c) => {
      c.settings.greeting = `Racing {firstName} (${mark})`;
    });
    // What publish read a moment ago, before that save.
    const stale = { ...edited, updatedAt: new Date(new Date(edited.updatedAt).getTime() - 60_000), hasUnpublishedChanges: true };
    const realGetDraft = SupportContentSvc.getDraft;
    (SupportContentSvc as any).getDraft = async () => stale;
    let failure: any;
    try {
      await SupportContentSvc.publish(adminId);
    } catch (err) {
      failure = err;
    } finally {
      (SupportContentSvc as any).getDraft = realGetDraft;
    }

    expect(failure).to.include({ statusCode: 409, code: "DRAFT_CONFLICT" });
    expect((await api.clientContent().expect(200)).body.version).to.equal(baseVersion + 1);
    expect(await prisma.supportContentVersion.count({ where: { version: { gt: baseVersion + 1 } } })).to.equal(0);
    expect((await api.draft().expect(200)).body.content.settings.greeting).to.equal(`Racing {firstName} (${mark})`);
    expect(auditRows.some((r) => r.action === "admin.support_content.published")).to.equal(false);

    await saveEdited((c) => {
      c.settings.greeting = `Hello {firstName} (${mark})`;
    });
  });

  it("lists versions newest first, with who published them and which is current", async () => {
    const { body } = await api.versions().expect(200);
    expect(body[0]).to.deep.include({ version: baseVersion + 1, isCurrent: true, rolledBackFromVersion: null });
    expect(body[0].publishedBy).to.deep.include({ id: adminId });
    expect(body.filter((v: any) => v.isCurrent)).to.have.length(1);
    expect(body.map((v: any) => v.version)).to.deep.equal([...body.map((v: any) => v.version)].sort((a, b) => b - a));

    const one = (await api.version(baseVersion).expect(200)).body;
    expect(one.content).to.deep.equal(baseContent);
    await api.version(baseVersion + 999).expect(404);
    await request(app).get("/api/admin/support/content/versions/abc").set(asAdmin).expect(400);
  });

  it("rolls back to an earlier version exactly, as a new version, and audits it", async () => {
    const res = await api.rollback(baseVersion).expect(201);
    expect(res.body).to.deep.include({ version: baseVersion + 2, rolledBackFromVersion: baseVersion });
    const row = auditRows.find((r) => r.action === "admin.support_content.rolled_back");
    expect(row).to.deep.include({ actorId: adminId, targetType: "support_content" });
    expect(row.payload).to.deep.include({ restoredVersion: baseVersion });

    const seen = (await api.clientContent().expect(200)).body;
    expect(seen.version).to.equal(baseVersion + 2);
    expect(seen.settings).to.deep.equal(baseContent.settings);
    expect((await api.version(baseVersion + 2).expect(200)).body.content).to.deep.equal(baseContent);
    expect((await api.version(baseVersion + 1).expect(200)).body.content.settings.greeting).to.equal(`Hello {firstName} (${mark})`);

    const draft = (await api.draft().expect(200)).body;
    expect(draft.hasUnpublishedChanges).to.equal(false);
    expect(draft.content).to.deep.equal(baseContent);
  });

  it("refuses to roll back to the version that's already published, or one that doesn't exist", async () => {
    expect((await api.rollback(baseVersion + 2).expect(409)).body.code).to.equal("ALREADY_CURRENT");
    expect((await api.rollback(baseVersion + 999).expect(404)).body.code).to.equal("SUPPORT_VERSION_NOT_FOUND");
  });
});
