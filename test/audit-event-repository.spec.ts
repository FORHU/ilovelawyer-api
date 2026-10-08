/** AuditEventRepo.list — the admin audit-trail query. Runs against the real database, like the
 * organization specs: it creates its own user and rows (tagged in the payload) and removes them. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after } from "mocha";
import prisma from "../src/lib/prisma";
import AuditEventRepo from "../src/repositories/audit-event.repository";

describe("AuditEventRepo.list", () => {
  const tag = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const email = `audit-list-${userId}@example.com`;

  before(async () => {
    await prisma.user.create({ data: { id: userId, email, username: `audit-list-${userId}` } });
    const base = Date.now();
    for (const [i, action] of ["auth.login", "document.delete", "org.member_left"].entries()) {
      await prisma.auditEvent.create({
        data: { actorId: userId, action, payload: { tag }, createdAt: new Date(base + i * 1000) },
      });
    }
  });

  after(async () => {
    await prisma.auditEvent.deleteMany({ where: { payload: { path: ["tag"], equals: tag } } });
    await prisma.user.delete({ where: { id: userId } });
  });

  it("returns newest first with the actor's email", async () => {
    const { data, total } = await AuditEventRepo.list({ page: 1, limit: 10, sortDir: "desc", actorId: userId });
    expect(total).to.equal(3);
    expect(data.map((e) => e.action)).to.deep.equal(["org.member_left", "document.delete", "auth.login"]);
    expect(data[0]!.actor).to.deep.include({ id: userId, email });
  });

  it("pages through the results", async () => {
    const first = await AuditEventRepo.list({ page: 1, limit: 2, sortDir: "desc", actorId: userId });
    const second = await AuditEventRepo.list({ page: 2, limit: 2, sortDir: "desc", actorId: userId });
    expect(first.data).to.have.length(2);
    expect(second.data.map((e) => e.action)).to.deep.equal(["auth.login"]);
    expect(first.total).to.equal(3);
  });

  it("searches by action name and by the actor's email, ignoring case", async () => {
    const byAction = await AuditEventRepo.list({ page: 1, limit: 10, sortDir: "desc", actorId: userId, q: "DOCUMENT" });
    expect(byAction.data.map((e) => e.action)).to.deep.equal(["document.delete"]);

    const byEmail = await AuditEventRepo.list({ page: 1, limit: 10, sortDir: "desc", q: email.toUpperCase() });
    expect(byEmail.total).to.equal(3);
  });

  it("turns ids in the payload into names, and leaves out an id that no longer exists", async () => {
    const goneOrganizationId = crypto.randomUUID();
    await prisma.auditEvent.create({
      data: {
        actorId: userId,
        action: "org.member_removed",
        payload: { tag, targetUserId: userId, organizationId: goneOrganizationId },
        createdAt: new Date(Date.now() + 60_000),
      },
    });

    const { data, resolved } = await AuditEventRepo.list({ page: 1, limit: 10, sortDir: "desc", actorId: userId });
    expect(data[0]!.action).to.equal("org.member_removed");
    expect(resolved.users[userId]).to.deep.include({ email });
    expect(resolved.organizations).to.not.have.property(goneOrganizationId);
  });
});
