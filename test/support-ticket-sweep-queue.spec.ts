/** The sweep that closes Support Tickets nobody answered (SupportTicketSweepQueue): ANSWERED for 7 days
 * with no reply from the client. Against the real database, at a date in the past so real tickets are
 * never due; the security audit is captured. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after, beforeEach, afterEach } from "mocha";
import prisma from "../src/lib/prisma";
import SecurityAuditRepo from "../src/repositories/security-audit.repository";
import SupportTicketSweepQueue from "../src/queues/support-ticket-sweep.queue";
import { SUPPORT_AUTO_RESOLVE_NOTE } from "../src/constants/support-ticket.constants";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-01-20T09:00:00Z");

describe("Support ticket sweep", () => {
  const clientIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const mark = crypto.randomUUID().slice(0, 8);
  let auditRows: any[];
  let savedAuditCreate: unknown;

  const ticket = (over: Record<string, unknown>) =>
    prisma.supportTicket.create({
      data: { email: `sweep-${mark}@example.com`, source: "SIGNED_IN", context: {}, status: "ANSWERED", answeredAt: new Date(NOW.getTime() - 8 * DAY_MS), ...over } as any,
    });

  before(async () => {
    await prisma.user.createMany({ data: clientIds.map((id) => ({ id, email: `sweep-${mark}-${id}@example.com`, username: `sweep-${mark}-${id}`, role: "USER" as const })) });
  });
  after(async () => {
    await prisma.supportTicket.deleteMany({ where: { email: `sweep-${mark}@example.com` } });
    await prisma.user.deleteMany({ where: { id: { in: clientIds } } });
  });
  beforeEach(async () => {
    await prisma.supportTicket.deleteMany({ where: { email: `sweep-${mark}@example.com` } });
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

  const status = async (id: string) => prisma.supportTicket.findUniqueOrThrow({ where: { id }, include: { messages: true } });

  it("resolves an answered ticket after 7 days, says so in the thread, and frees the client to open another", async () => {
    const old = await ticket({ userId: clientIds[0], openUserId: clientIds[0] });
    const { resolved } = await SupportTicketSweepQueue.tick(NOW);
    expect(resolved).to.be.at.least(1);

    const after = await status(old.id);
    expect(after).to.deep.include({ status: "RESOLVED", openUserId: null });
    expect(after.resolvedAt?.toISOString()).to.equal(NOW.toISOString());
    expect(after.messages.map((m) => [m.author, m.body])).to.deep.equal([["SYSTEM", SUPPORT_AUTO_RESOLVE_NOTE]]);
    expect(auditRows.find((r) => r.action === "system.support_ticket.auto_resolved")).to.deep.include({ actorId: null, targetType: "support_ticket", targetId: old.id });

    await ticket({ userId: clientIds[0], openUserId: clientIds[0], status: "OPEN", answeredAt: null });
  });

  it("leaves alone a ticket answered less than 7 days ago, and one that's waiting on us", async () => {
    const recent = await ticket({ userId: clientIds[1], openUserId: clientIds[1], answeredAt: new Date(NOW.getTime() - 6 * DAY_MS - 23 * 60 * 60 * 1000) });
    const open = await ticket({ userId: clientIds[2], openUserId: clientIds[2], status: "OPEN", answeredAt: null, lastMessageAt: new Date(NOW.getTime() - 30 * DAY_MS) });
    await SupportTicketSweepQueue.tick(NOW);
    expect((await status(recent.id)).status).to.equal("ANSWERED");
    expect((await status(open.id)).status).to.equal("OPEN");
  });

  it("closes a visitor's ticket the same way", async () => {
    const visitor = await ticket({ source: "SIGNED_OUT", userId: null, openUserId: null });
    await SupportTicketSweepQueue.tick(NOW);
    expect((await status(visitor.id)).status).to.equal("RESOLVED");
  });

  it("doesn't close one twice", async () => {
    const old = await ticket({ userId: clientIds[0], openUserId: clientIds[0] });
    await SupportTicketSweepQueue.tick(NOW);
    const again = await SupportTicketSweepQueue.tick(new Date(NOW.getTime() + DAY_MS));
    expect(again.resolved).to.equal(0);
    expect((await status(old.id)).messages).to.have.length(1);
  });

  it("doesn't close one the client has answered since (it is OPEN again)", async () => {
    const old = await ticket({ userId: clientIds[0], openUserId: clientIds[0] });
    await prisma.supportTicket.update({ where: { id: old.id }, data: { status: "OPEN", answeredAt: null } });
    await SupportTicketSweepQueue.tick(NOW);
    expect((await status(old.id)).status).to.equal("OPEN");
  });
});
