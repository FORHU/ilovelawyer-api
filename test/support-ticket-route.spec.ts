/** Support Tickets (SupportTicketSvc): a signed-in client's one conversation with the team, an admin
 * answering it, a visitor's ticket from the sign-in page, and the outcome logging and report behind the
 * Support Chat. Through the real routes against the real database. Emails, the socket, the captcha and the
 * security audit are captured or replaced. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, before, after, beforeEach, afterEach } from "mocha";
import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import { ACCESS_TOKEN_SECRET } from "../src/config";
import SecurityAuditRepo from "../src/repositories/security-audit.repository";
import ClientCaseSvc from "../src/services/client-case.service";
import SupportContentSvc from "../src/services/support-content.service";
import type { SupportContent } from "../src/types/support-content";
import * as mailerModule from "../src/utils/mailer";
import * as socketModule from "../src/lib/socket";
import * as turnstileModule from "../src/utils/turnstile";

const tokenFor = (userId: string) => jwt.sign({ userId }, ACCESS_TOKEN_SECRET, { expiresIn: "1h" });
const HOUR_MS = 60 * 60 * 1000;

describe("Support tickets", () => {
  const adminId = crypto.randomUUID();
  const clientId = crypto.randomUUID();
  const otherId = crypto.randomUUID();
  const lawyerId = crypto.randomUUID();
  const ids = [adminId, clientId, otherId, lawyerId];
  const mark = crypto.randomUUID().slice(0, 8);
  const clientEmail = `tk-client-${clientId}@example.com`;
  let asAdmin: { Authorization: string };
  let asClient: { Authorization: string };
  let asLawyer: { Authorization: string };
  let caseId: string;
  let requestId: string;
  let otherCaseId: string;
  let otherRequestId: string;

  let saved: Record<string, unknown>;
  let emails: { to: string; subject: string; text?: string; html?: string }[];
  let emitted: { userId: string; event: string; payload: unknown }[];
  let auditRows: any[];

  const client = {
    thread: () => request(app).get("/api/client/support/ticket").set(asClient),
    send: (body: unknown, context?: unknown) => request(app).post("/api/client/support/ticket/messages").set(asClient).send({ body, context }),
    read: () => request(app).post("/api/client/support/ticket/read").set(asClient),
    outcomes: (events: unknown) => request(app).post("/api/client/support/outcomes").set(asClient).send({ events }),
  };
  const admin = {
    list: (query = "") => request(app).get(`/api/admin/support/tickets${query}`).set(asAdmin),
    get: (id: string) => request(app).get(`/api/admin/support/tickets/${id}`).set(asAdmin),
    reply: (id: string, body: unknown) => request(app).post(`/api/admin/support/tickets/${id}/replies`).set(asAdmin).send({ body }),
    resolve: (id: string) => request(app).post(`/api/admin/support/tickets/${id}/resolve`).set(asAdmin),
    reopen: (id: string) => request(app).post(`/api/admin/support/tickets/${id}/reopen`).set(asAdmin),
    report: (query: string) => request(app).get(`/api/admin/support/report${query}`).set(asAdmin),
  };
  const visitor = (body: object) => request(app).post("/api/support/tickets").send(body);
  const freshEmail = () => `tk-visitor-${crypto.randomUUID()}@example.com`;
  const ticketsOf = (userId: string) => prisma.supportTicket.findMany({ where: { userId }, include: { messages: true } });

  before(async () => {
    await prisma.user.createMany({
      data: [
        { id: adminId, email: `tk-admin-${adminId}@example.com`, username: `tk-admin-${adminId}`, role: "ADMIN", name: "Ada Admin" },
        { id: clientId, email: clientEmail, username: `tk-client-${clientId}`, role: "USER", name: "Cleo Client" },
        { id: otherId, email: `tk-other-${otherId}@example.com`, username: `tk-other-${otherId}`, role: "USER" },
        { id: lawyerId, email: `tk-lawyer-${lawyerId}@example.com`, username: `tk-lawyer-${lawyerId}`, role: "LAWYER" },
      ],
    });
    asAdmin = { Authorization: `Bearer ${tokenFor(adminId)}` };
    asClient = { Authorization: `Bearer ${tokenFor(clientId)}` };
    asLawyer = { Authorization: `Bearer ${tokenFor(lawyerId)}` };
    const mine = await ClientCaseSvc.workspaceFor(clientId, "Tk Client");
    const theirs = await ClientCaseSvc.workspaceFor(otherId, "Tk Other");
    caseId = (await prisma.case.create({ data: { userId: clientId, organizationId: mine.id, caseName: "Smith v Jones Ltd" } })).id;
    otherCaseId = (await prisma.case.create({ data: { userId: otherId, organizationId: theirs.id, caseName: "Someone else's case" } })).id;
    const base = { consentVersion: "test", consentAcceptedAt: new Date() };
    requestId = (await prisma.clientRequest.create({ data: { ...base, caseId, clientId, status: "ENGAGED" } })).id;
    otherRequestId = (await prisma.clientRequest.create({ data: { ...base, caseId: otherCaseId, clientId: otherId, status: "ROUTED" } })).id;
  });

  after(async () => {
    await prisma.supportTicket.deleteMany({ where: { OR: [{ userId: { in: ids } }, { email: { contains: "tk-visitor-" } }] } });
    await prisma.supportOutcome.deleteMany({ where: { OR: [{ flowId: { startsWith: mark } }, { text: { contains: mark } }] } });
    await prisma.clientRequest.deleteMany({ where: { clientId: { in: ids } } });
    await prisma.case.deleteMany({ where: { id: { in: [caseId, otherCaseId] } } });
    await prisma.organization.deleteMany({ where: { createdById: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });

  beforeEach(async () => {
    await prisma.supportTicket.deleteMany({ where: { OR: [{ userId: { in: ids } }, { email: { contains: "tk-visitor-" } }] } });
    saved = {
      sendEmail: (mailerModule as any).sendEmail,
      emitToUser: (socketModule as any).emitToUser,
      verifyTurnstile: (turnstileModule as any).verifyTurnstile,
      auditCreate: (SecurityAuditRepo as any).create,
    };
    emails = [];
    emitted = [];
    auditRows = [];
    (mailerModule as any).sendEmail = async (mail: { to: string; subject: string }) => void emails.push(mail);
    (socketModule as any).emitToUser = (userId: string, event: string, payload: unknown) => void emitted.push({ userId, event, payload });
    (turnstileModule as any).verifyTurnstile = async (token: string | undefined) => token === "pass";
    (SecurityAuditRepo as any).create = async (data: object) => {
      auditRows.push(data);
      return { id: "row", createdAt: new Date(), ...data };
    };
  });
  afterEach(() => {
    (mailerModule as any).sendEmail = saved.sendEmail;
    (socketModule as any).emitToUser = saved.emitToUser;
    (turnstileModule as any).verifyTurnstile = saved.verifyTurnstile;
    (SecurityAuditRepo as any).create = saved.auditCreate;
  });

  describe("the signed-in client", () => {
    it("is for client accounts only", async () => {
      for (const [method, path] of [["get", "/ticket"], ["post", "/ticket/messages"], ["post", "/ticket/read"], ["post", "/outcomes"]] as const) {
        await (request(app) as any)[method](`/api/client/support${path}`).set(asLawyer).send({}).expect(403);
        await (request(app) as any)[method](`/api/client/support${path}`).send({}).expect(401);
      }
    });

    it("has no thread until they write", async () => {
      expect((await client.thread().expect(200)).body).to.equal(null);
    });

    it("opens a ticket with their first message, and attaches only where it came from", async () => {
      const res = await client
        .send("My top-up never arrived", { flowPath: ["credits-payments", "topup-missing"], page: "/cases/abc?token=secret#frag", clientRequestId: requestId })
        .expect(201);
      expect(res.body).to.deep.include({ status: "OPEN", unreadCount: 0 });
      expect(res.body.messages).to.have.length(1);
      expect(res.body.messages[0]).to.deep.include({ author: "CLIENT", body: "My top-up never arrived" });

      const [ticket] = await ticketsOf(clientId);
      expect(ticket).to.deep.include({ source: "SIGNED_IN", openUserId: clientId, flowId: "topup-missing", email: clientEmail, name: "Cleo Client" });
      expect(ticket.context).to.deep.equal({
        name: "Cleo Client",
        email: clientEmail,
        flowPath: ["credits-payments", "topup-missing"],
        page: "/cases/abc",
        caseId,
        clientRequestId: requestId,
        clientRequestStatus: "ENGAGED",
      });
      const stored = JSON.stringify(ticket.context);
      for (const leak of ["Smith", "Jones", "secret", "frag", "token"]) expect(stored).to.not.include(leak);
      expect(auditRows.find((r) => r.action === "support_ticket.opened")).to.deep.include({ actorId: clientId, targetType: "support_ticket", targetId: ticket.id });
    });

    it("keeps a case or request that isn't theirs out of the context", async () => {
      await client.send("Help", { caseId: otherCaseId, clientRequestId: otherRequestId }).expect(201);
      const [ticket] = await ticketsOf(clientId);
      expect(ticket.context).to.deep.include({ caseId: null, clientRequestId: null, clientRequestStatus: null });
    });

    it("takes just a case id, if that's all they have", async () => {
      await client.send("Help", { caseId }).expect(201);
      expect(((await ticketsOf(clientId))[0].context as any).caseId).to.equal(caseId);
    });

    it("adds later messages to the same ticket", async () => {
      const first = await client.send("One").expect(201);
      const second = await client.send("Two").expect(201);
      expect(second.body.id).to.equal(first.body.id);
      expect(second.body.messages.map((m: any) => m.body)).to.deep.equal(["One", "Two"]);
      expect(await ticketsOf(clientId)).to.have.length(1);
    });

    it("makes one ticket from messages sent at the same moment", async () => {
      const results = await Promise.all([client.send("A"), client.send("B"), client.send("C")]);
      for (const res of results) expect(res.status).to.equal(201);
      const tickets = await ticketsOf(clientId);
      expect(tickets).to.have.length(1);
      expect(tickets[0].messages).to.have.length(3);
    });

    it("takes text only, and not an empty or very long message", async () => {
      await client.send("").expect(400);
      await client.send("   ").expect(400);
      await client.send("x".repeat(4001)).expect(400);
      await client.send("x".repeat(4000)).expect(201);
      await request(app).post("/api/client/support/ticket/messages").set(asClient).send({ body: "Hi", attachments: ["a.pdf"] }).expect(400);
      await client.send("Hi", { flowPath: "nope" }).expect(400);
      await client.send("Hi", { flowPath: ["not a flow id!"] }).expect(400);
    });

    it("tells the client about a reply live and by email, with a link and not the reply itself", async () => {
      const { body: thread } = await client.send("Where is my refund?").expect(201);
      const reply = await admin.reply(thread.id, "Hello Cleo,\nit went out today.").expect(201);
      expect(reply.body).to.deep.include({ author: "ADMIN", body: "Hello Cleo,\nit went out today.", ticketStatus: "ANSWERED" });

      expect(emitted).to.deep.equal([{ userId: clientId, event: "support:reply", payload: { ticketId: thread.id, messageId: reply.body.id } }]);
      expect(emails).to.have.length(1);
      expect(emails[0]).to.deep.include({ to: clientEmail, subject: "You have a reply from ilovelawyer support" });
      expect(emails[0].html).to.match(/\?support(=|&#x3D;)open/);
      expect(emails[0].text).to.include("/?support=open");
      expect(`${emails[0].html}${emails[0].text}`).to.not.include("went out today");
      expect(auditRows.find((r) => r.action === "admin.support_ticket.replied")).to.deep.include({ actorId: adminId, targetType: "support_ticket", targetId: thread.id });
      expect(JSON.stringify(auditRows)).to.not.include("went out today");
    });

    it("shows the reply as unread until the sheet is opened", async () => {
      const { body: thread } = await client.send("Hello").expect(201);
      await admin.reply(thread.id, "Hi there").expect(201);
      const unread = (await client.thread().expect(200)).body;
      expect(unread).to.deep.include({ id: thread.id, status: "ANSWERED", unreadCount: 1 });
      expect(unread.messages.map((m: any) => m.author)).to.deep.equal(["CLIENT", "ADMIN"]);
      await client.read().expect(204);
      expect((await client.thread().expect(200)).body.unreadCount).to.equal(0);
    });

    it("moves an answered ticket back to open when the client replies", async () => {
      const { body: thread } = await client.send("Hello").expect(201);
      await admin.reply(thread.id, "Hi there").expect(201);
      const res = await client.send("Thanks, one more thing").expect(201);
      expect(res.body).to.deep.include({ id: thread.id, status: "OPEN", unreadCount: 0 });
      const row = await prisma.supportTicket.findUniqueOrThrow({ where: { id: thread.id } });
      expect(row.answeredAt).to.equal(null);
    });
  });

  describe("resolving and reopening", () => {
    it("won't reply to a resolved ticket, resolves once, and lets the client start a new one", async () => {
      const { body: first } = await client.send("First").expect(201);
      const resolved = await admin.resolve(first.id).expect(200);
      expect(resolved.body.status).to.equal("RESOLVED");
      expect((await prisma.supportTicket.findUniqueOrThrow({ where: { id: first.id } })).openUserId).to.equal(null);
      expect(auditRows.find((r) => r.action === "admin.support_ticket.resolved")).to.deep.include({ actorId: adminId, targetId: first.id });

      expect((await admin.reply(first.id, "Too late").expect(409)).body.code).to.equal("TICKET_RESOLVED");
      expect((await admin.resolve(first.id).expect(409)).body.code).to.equal("TICKET_ALREADY_RESOLVED");

      const second = await client.send("Second").expect(201);
      expect(second.body.id).to.not.equal(first.id);
      expect(await ticketsOf(clientId)).to.have.length(2);
    });

    it("reopens a resolved ticket unless the client has another open one", async () => {
      const { body: first } = await client.send("First").expect(201);
      await admin.resolve(first.id).expect(200);
      const { body: second } = await client.send("Second").expect(201);

      expect((await admin.reopen(first.id).expect(409)).body.code).to.equal("CLIENT_HAS_OPEN_TICKET");
      await admin.resolve(second.id).expect(200);
      const reopened = await admin.reopen(first.id).expect(200);
      expect(reopened.body.status).to.equal("OPEN");
      expect((await prisma.supportTicket.findUniqueOrThrow({ where: { id: first.id } })).openUserId).to.equal(clientId);
      expect(auditRows.find((r) => r.action === "admin.support_ticket.reopened")).to.deep.include({ actorId: adminId, targetId: first.id });

      expect((await admin.reopen(first.id).expect(409)).body.code).to.equal("TICKET_NOT_RESOLVED");
    });

    it("answers 404 for a ticket that doesn't exist", async () => {
      for (const call of [admin.get, admin.resolve, admin.reopen]) expect((await call(crypto.randomUUID()).expect(404)).body.code).to.equal("TICKET_NOT_FOUND");
      await admin.reply(crypto.randomUUID(), "Hi").expect(404);
    });
  });

  describe("the admin's inbox", () => {
    it("is for admins only", async () => {
      const routes: [string, string][] = [
        ["get", "/api/admin/support/tickets"],
        ["get", "/api/admin/support/tickets/x"],
        ["post", "/api/admin/support/tickets/x/replies"],
        ["post", "/api/admin/support/tickets/x/resolve"],
        ["post", "/api/admin/support/tickets/x/reopen"],
        ["get", "/api/admin/support/report"],
      ];
      for (const [method, path] of routes) {
        for (const who of [asClient, asLawyer]) await (request(app) as any)[method](path).set(who).send({}).expect(403);
        await (request(app) as any)[method](path).send({}).expect(401);
      }
    });

    it("lists tickets with their first message, age and whether they're overdue, and filters and sorts them", async () => {
      const { body: open } = await client.send("My first message ".repeat(20)).expect(201);
      const visitorEmail = freshEmail();
      await visitor({ email: visitorEmail, message: "I can't sign in", turnstileToken: "pass" }).expect(202);
      const signedOut = await prisma.supportTicket.findFirstOrThrow({ where: { email: visitorEmail } });
      await prisma.supportTicket.update({ where: { id: signedOut.id }, data: { status: "ANSWERED", answeredAt: new Date() } });
      await prisma.supportTicket.update({ where: { id: open.id }, data: { createdAt: new Date(Date.now() - 30 * HOUR_MS), lastMessageAt: new Date(Date.now() - 25 * HOUR_MS) } });

      const all = (await admin.list(`?q=${encodeURIComponent("example.com")}&sort=age`).expect(200)).body;
      const mine = all.data.filter((t: any) => [open.id, signedOut.id].includes(t.id));
      expect(mine.map((t: any) => t.id)).to.deep.equal([open.id, signedOut.id]);
      expect(mine[0]).to.deep.include({ status: "OPEN", source: "SIGNED_IN", userId: clientId, email: clientEmail, name: "Cleo Client", overdue: true, ageHours: 30 });
      expect(mine[0].firstMessage).to.have.length(140);
      expect(mine[1]).to.deep.include({ status: "ANSWERED", source: "SIGNED_OUT", userId: null, email: visitorEmail, overdue: false });
      expect(all).to.deep.include({ page: 1, pageSize: 25 });

      const onlyOpen = (await admin.list(`?status=OPEN&q=${clientId}`).expect(200)).body;
      expect(onlyOpen.data.map((t: any) => t.id)).to.deep.equal([open.id]);
      expect((await admin.list(`?status=ANSWERED&q=${clientId}`).expect(200)).body.data).to.deep.equal([]);
      await admin.list("?status=NOPE").expect(400);
      await admin.list("?sort=oldest").expect(400);
    });

    it("doesn't call a ticket overdue once the client has written again", async () => {
      const { body } = await client.send("Hello").expect(201);
      await prisma.supportTicket.update({ where: { id: body.id }, data: { lastMessageAt: new Date(Date.now() - 26 * HOUR_MS) } });
      expect((await admin.get(body.id).expect(200)).body.overdue).to.equal(true);
      await client.send("Still there?").expect(201);
      expect((await admin.get(body.id).expect(200)).body.overdue).to.equal(false);
    });

    it("shows the thread and the context the bot attached", async () => {
      const { body: thread } = await client.send("Help", { flowPath: ["report-issue"], page: "/cases/x", clientRequestId: requestId }).expect(201);
      await admin.reply(thread.id, "On it").expect(201);
      const { body } = await admin.get(thread.id).expect(200);
      expect(body).to.deep.include({ id: thread.id, status: "ANSWERED", flowId: "report-issue", userId: clientId });
      expect(body.context).to.deep.include({ page: "/cases/x", caseId, clientRequestId: requestId, clientRequestStatus: "ENGAGED", flowPath: ["report-issue"] });
      expect(body.messages.map((m: any) => [m.author, m.authorName])).to.deep.equal([
        ["CLIENT", "Cleo Client"],
        ["ADMIN", "Ada Admin"],
      ]);
    });
  });

  describe("a visitor who isn't signed in", () => {
    it("needs the captcha", async () => {
      const email = freshEmail();
      expect((await visitor({ email, message: "Hi", turnstileToken: "wrong" }).expect(400)).body.code).to.equal("CAPTCHA_FAILED");
      expect((await visitor({ email, message: "Hi" }).expect(400)).body.code).to.equal("CAPTCHA_FAILED");
      expect(await prisma.supportTicket.count({ where: { email } })).to.equal(0);
    });

    it("refuses a bad address or message", async () => {
      await visitor({ email: "nope", message: "Hi", turnstileToken: "pass" }).expect(400);
      await visitor({ email: freshEmail(), message: "", turnstileToken: "pass" }).expect(400);
      await visitor({ email: freshEmail(), message: "x".repeat(4001), turnstileToken: "pass" }).expect(400);
    });

    it("answers the same for an address with a client account and one without, and links the account quietly", async () => {
      const context = { flowPath: ["so-something-else"], page: "/login?next=/cases", caseId, clientRequestId: requestId };
      const known = await visitor({ email: clientEmail.toUpperCase(), message: "I'm locked out", turnstileToken: "pass", context }).expect(202);
      const unknownEmail = freshEmail();
      const unknown = await visitor({ email: unknownEmail, message: "I'm locked out", turnstileToken: "pass", context }).expect(202);
      expect(known.body).to.deep.equal({ ok: true });
      expect(unknown.body).to.deep.equal(known.body);

      const linked = await prisma.supportTicket.findFirstOrThrow({ where: { email: clientEmail, source: "SIGNED_OUT" } });
      expect(linked).to.deep.include({ userId: clientId, openUserId: null, flowId: "so-something-else" });
      expect(linked.context).to.deep.include({ page: "/login", caseId: null, clientRequestId: null });
      expect((await prisma.supportTicket.findFirstOrThrow({ where: { email: unknownEmail } })).userId).to.equal(null);
      expect(auditRows.filter((r) => r.action === "support_ticket.opened")).to.have.length(2);
    });

    it("keeps a visitor's ticket out of the account holder's own thread", async () => {
      await visitor({ email: clientEmail, message: "Not signed in", turnstileToken: "pass" }).expect(202);
      expect((await client.thread().expect(200)).body).to.equal(null);
    });

    it("is answered by email with the reply in it, and no socket event", async () => {
      const email = freshEmail();
      await visitor({ email, message: "Where is my code?", turnstileToken: "pass" }).expect(202);
      const ticket = await prisma.supportTicket.findFirstOrThrow({ where: { email } });
      await admin.reply(ticket.id, "Try again in a minute.\nThen check spam.").expect(201);
      expect(emitted).to.deep.equal([]);
      expect(emails).to.have.length(1);
      expect(emails[0]).to.deep.include({ to: email, subject: "You have a reply from ilovelawyer support" });
      expect(emails[0].html).to.match(new RegExp("Try again in a minute\\.<br\\s*/?>Then check spam\\."));
      expect(emails[0].text).to.include("Try again in a minute.");
    });

    it("limits tickets per address, with the same refusal for every address", async () => {
      const messages: string[] = [];
      for (const email of [freshEmail(), `tk-other-${otherId}@example.com`]) {
        for (let i = 0; i < 3; i++) await visitor({ email, message: `Hi ${i}`, turnstileToken: "pass" }).expect(202);
        const limited = await visitor({ email, message: "One more", turnstileToken: "pass" }).expect(429);
        expect(limited.body.message).to.not.match(/account|exist|registered/i);
        messages.push(limited.body.message);
      }
      expect(messages[0]).to.equal(messages[1]);
    });

    it("doesn't count a failed captcha against the address", async () => {
      const email = freshEmail();
      for (let i = 0; i < 4; i++) await visitor({ email, message: "Hi", turnstileToken: "wrong" }).expect(400);
      await visitor({ email, message: "Hi", turnstileToken: "pass" }).expect(202);
    });
  });

  describe("outcomes and the report", () => {
    it("records what happened, taking emails, phone numbers and postcodes out of unmatched text", async () => {
      const typed = `Call me on 07700 900123 or mail Jo@Example.com at SW1A 1AA about my  REFUND ${mark}`;
      await client
        .outcomes([
          { kind: "FLOW_STARTED", flowId: `${mark}-flow`, contentVersion: 3 },
          { kind: "HELPED_NO", flowId: `${mark}-flow`, text: "ignored for this kind" },
          { kind: "UNMATCHED", text: typed },
        ])
        .expect(204);
      const rows = await prisma.supportOutcome.findMany({ where: { OR: [{ flowId: `${mark}-flow` }, { text: { contains: mark } }] }, orderBy: { kind: "asc" } });
      expect(rows.map((r) => r.kind).sort()).to.deep.equal(["FLOW_STARTED", "HELPED_NO", "UNMATCHED"]);
      expect(rows.find((r) => r.kind === "FLOW_STARTED")).to.deep.include({ contentVersion: 3, text: null });
      expect(rows.find((r) => r.kind === "HELPED_NO")?.text).to.equal(null);
      const unmatched = rows.find((r) => r.kind === "UNMATCHED")?.text as string;
      expect(unmatched).to.equal(`call me on [phone removed] or mail [email removed] at [postcode removed] about my refund ${mark}`);
      expect(unmatched).to.not.match(/\d{5}|@/);
    });

    it("also takes them from a visitor, with nothing to say who they are", async () => {
      await request(app).post("/api/support/outcomes").send({ events: [{ kind: "FLOW_STARTED", flowId: `${mark}-visitor` }] }).expect(204);
      expect(await prisma.supportOutcome.count({ where: { flowId: `${mark}-visitor` } })).to.equal(1);
    });

    it("refuses a batch that's empty, too big, or has an unknown kind or a bad flow id", async () => {
      const ok = { kind: "FLOW_STARTED", flowId: `${mark}-x` };
      await client.outcomes([]).expect(400);
      await client.outcomes(Array.from({ length: 21 }, () => ok)).expect(400);
      await client.outcomes([{ kind: "BOUGHT_A_COFFEE" }]).expect(400);
      await client.outcomes([{ kind: "FLOW_STARTED", flowId: "has spaces" }]).expect(400);
      await client.outcomes(Array.from({ length: 20 }, () => ok)).expect(204);
      await prisma.supportOutcome.deleteMany({ where: { flowId: `${mark}-x` } });
    });

    describe("the report", () => {
      const from = "2026-01-01T00:00:00.000Z";
      const to = "2026-01-02T00:00:00.000Z";
      const at = new Date("2026-01-01T12:00:00.000Z");
      const rows = (kind: string, flowId: string | null, count: number, text: string | null = null, createdAt = at) =>
        Array.from({ length: count }, () => ({ kind: kind as any, flowId, text, createdAt }));

      before(async () => {
        await prisma.supportOutcome.createMany({
          data: [
            ...rows("FLOW_STARTED", `${mark}-a`, 4),
            ...rows("HELPED_YES", `${mark}-a`, 1),
            ...rows("HELPED_NO", `${mark}-a`, 2),
            ...rows("ESCALATED", `${mark}-a`, 1),
            ...rows("FLOW_STARTED", `${mark}-b`, 2),
            ...rows("HELPED_YES", `${mark}-b`, 2),
            ...rows("UNMATCHED", null, 3, `refund pls ${mark}`),
            ...rows("UNMATCHED", null, 1, `other thing ${mark}`),
            ...rows("FLOW_STARTED", `${mark}-a`, 5, null, new Date(to)),
            ...rows("FLOW_STARTED", `${mark}-a`, 5, null, new Date("2025-12-31T23:59:59.000Z")),
          ],
        });
      });

      it("counts each flow, worst first, and the phrases that matched nothing, for the range", async () => {
        const { body } = await admin.report(`?from=${from}&to=${to}`).expect(200);
        const flows = body.flows.filter((f: any) => f.flowId.startsWith(mark));
        expect(flows.map((f: any) => f.flowId)).to.deep.equal([`${mark}-a`, `${mark}-b`]);
        expect(flows[0]).to.deep.include({ started: 4, helpedYes: 1, helpedNo: 2, escalated: 1, helpedYesRate: 0.333, helpedNoRate: 0.667, escalationRate: 0.25, flowTitle: null });
        expect(flows[1]).to.deep.include({ started: 2, helpedYes: 2, helpedNo: 0, escalated: 0, helpedYesRate: 1, helpedNoRate: 0, escalationRate: 0 });
        expect(body.unmatchedPhrases.filter((p: any) => p.text.includes(mark))).to.deep.equal([
          { text: `refund pls ${mark}`, count: 3 },
          { text: `other thing ${mark}`, count: 1 },
        ]);
        expect(body.totals).to.deep.include({ started: 6, helpedYes: 3, helpedNo: 2, escalated: 1, unmatched: 4 });
        expect(body.totals.escalationRate).to.be.closeTo(1 / 6, 0.001);
      });

      it("leaves out what's before the range and what's exactly at its end", async () => {
        const { body } = await admin.report(`?from=${from}&to=${to}`).expect(200);
        expect(body.flows.find((f: any) => f.flowId === `${mark}-a`).started).to.equal(4);
      });

      it("names a flow by its published title", async () => {
        const published = (await SupportContentSvc.latestVersion()).content as unknown as SupportContent;
        const [flowId, flow] = Object.entries(published.flows)[0];
        const created = await prisma.supportOutcome.create({ data: { kind: "FLOW_STARTED", flowId, createdAt: at } });
        const { body } = await admin.report(`?from=${from}&to=${to}`).expect(200);
        expect(body.flows.find((f: any) => f.flowId === flowId)?.flowTitle).to.equal(flow.title);
        await prisma.supportOutcome.delete({ where: { id: created.id } });
      });

      it("needs a range that makes sense", async () => {
        await admin.report("").expect(400);
        await admin.report(`?from=${from}`).expect(400);
        await admin.report(`?from=${to}&to=${from}`).expect(400);
        await admin.report(`?from=${from}&to=${from}`).expect(400);
        expect((await admin.report("?from=2024-01-01&to=2026-01-01").expect(400)).body.code).to.equal("INVALID_RANGE");
        await admin.report("?from=nope&to=2026-01-02").expect(400);
      });
    });
  });
});
