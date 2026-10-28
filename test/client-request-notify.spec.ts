/** ClientRequestNotifySvc — telling people about client requests (#510): announcing a request to
 * the lawyers it's routed to, expiring one nobody claimed in 48h (ops get a digest), and reminding
 * a lawyer 2h before their hold ends. No live Postgres: repositories, the mailer and the template
 * renderer are monkeypatched, same idiom as test/account-deletion-queue.spec.ts. The guards that
 * stop anything being sent twice run against the database in
 * test/client-request-claim-repository.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import ClientRequestNotifySvc from "../src/services/client-request-notify.service";
import ClientRequestRepo from "../src/repositories/client-request.repository";
import ClientRequestClaimRepo from "../src/repositories/client-request-claim.repository";
import LawyerProfileRepo from "../src/repositories/lawyer-profile.repository";
import ClientRequestMatchingSvc from "../src/services/client-request-matching.service";
import NotificationSvc from "../src/services/notification.service";
import * as socket from "../src/lib/socket";
import * as mailerModule from "../src/utils/mailer";
import * as templateModule from "../src/utils/template";
import { OPS_ALERT_EMAILS } from "../src/config";

/** Saves the named statics so afterEach can put them back. Spreading a class copies none of its
 * static methods, so `{ ...Repo }` would restore nothing. */
function stash<T extends object>(target: T, keys: (keyof T)[]) {
  const saved = keys.map((k) => [k, target[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

const NOW = new Date("2026-10-22T09:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const BRIEF = { summary: "Dismissed by text after raising a grievance.", caseAreas: ["Employment"], ukJurisdiction: "England and Wales", urgency: "URGENT" };

describe("ClientRequestNotifySvc", () => {
  let restore: (() => void)[];
  let announceable: Set<string>;
  let emitted: [string, string, any][];
  let notifications: any[];
  let emails: { to: string; subject: string; html?: string }[];
  let rendered: { name: string; vars: Record<string, unknown> }[];
  let eligible: string[];
  let opsBefore: string[];

  const request = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    caseId: `case-${id}`,
    clientId: `client-${id}`,
    brief: BRIEF,
    routedAt: new Date(NOW.getTime() - 48 * HOUR_MS),
    routingExpiresAt: new Date(NOW.getTime() - 60_000),
    case: { caseAreas: ["EMPLOYMENT"], ukJurisdiction: "England and Wales" },
    client: { email: `client-${id}@example.com` },
    ...overrides,
  });

  beforeEach(() => {
    restore = [
      stash(ClientRequestRepo, ["claimAnnouncement", "findForAnnouncement", "findUnannounced", "findExpired", "expire"]),
      stash(ClientRequestClaimRepo, ["findDueReminders", "markReminderSent"]),
      stash(LawyerProfileRepo, ["findEmails"]),
      stash(ClientRequestMatchingSvc, ["eligibleLawyerIds"]),
      stash(NotificationSvc, ["create"]),
      stash(socket, ["emitToUser"]),
      stash(mailerModule, ["sendEmail"]),
      stash(templateModule, ["renderTemplate"]),
    ];
    opsBefore = [...OPS_ALERT_EMAILS];
    OPS_ALERT_EMAILS.splice(0, OPS_ALERT_EMAILS.length, "ops@example.com");
    announceable = new Set(["req-1"]);
    emitted = [];
    notifications = [];
    emails = [];
    rendered = [];
    eligible = ["lawyer-a", "lawyer-b"];

    (ClientRequestRepo as any).claimAnnouncement = async (id: string) => announceable.delete(id);
    (ClientRequestRepo as any).findForAnnouncement = async (id: string) => request(id, { routingExpiresAt: new Date(NOW.getTime() + 47 * HOUR_MS) });
    (ClientRequestMatchingSvc as any).eligibleLawyerIds = async () => eligible;
    (LawyerProfileRepo as any).findEmails = async (ids: string[]) => ids.map((id) => ({ id, email: `${id}@example.com` }));
    (NotificationSvc as any).create = async (input: any) => notifications.push(input);
    (socket as any).emitToUser = (userId: string, event: string, payload: unknown) => emitted.push([userId, event, payload]);
    (templateModule as any).renderTemplate = async (name: string, vars: Record<string, unknown>) => {
      rendered.push({ name, vars });
      return `<html>${name} ${JSON.stringify(vars)}</html>`;
    };
    (mailerModule as any).sendEmail = async (mail: { to: string; subject: string; html?: string }) => {
      emails.push(mail);
      return "sent";
    };
  });

  afterEach(() => {
    restore.forEach((r) => r());
    OPS_ALERT_EMAILS.splice(0, OPS_ALERT_EMAILS.length, ...opsBefore);
  });

  describe("announce", () => {
    it("tells every matching lawyer: live, in the bell and by email", async () => {
      expect(await ClientRequestNotifySvc.announce("req-1", NOW)).to.equal(2);

      const live = emitted.filter(([, event]) => event === "client-request:new");
      expect(live.map(([userId]) => userId)).to.deep.equal(["lawyer-a", "lawyer-b"]);
      expect(live[0]![2]).to.deep.equal({
        requestId: "req-1",
        caseAreas: ["Employment"],
        ukJurisdiction: "England and Wales",
        urgency: "URGENT",
        routingExpiresAt: new Date(NOW.getTime() + 47 * HOUR_MS).toISOString(),
      });
      expect(notifications.map((n) => n.userId)).to.deep.equal(["lawyer-a", "lawyer-b"]);
      expect(notifications[0]).to.deep.include({ type: "CLIENT_REQUEST", link: "/homepage/client-requests" });
      expect(notifications[0]).to.not.have.property("organizationId");
      expect(emails.map((e) => e.to)).to.deep.equal(["lawyer-a@example.com", "lawyer-b@example.com"]);
      expect(rendered[0]!.name).to.equal("client-request-new");
    });

    it("emails the area, the part of the UK and the urgency, never the brief's summary", async () => {
      await ClientRequestNotifySvc.announce("req-1", NOW);

      expect(rendered[0]!.vars).to.deep.include({ practiceArea: "Employment", ukJurisdiction: "England and Wales", urgency: "Urgent: a deadline within 7 days" });
      expect(emails[0]!.subject).to.equal("New client request: Employment, England and Wales");
      for (const mail of emails) expect(JSON.stringify(mail)).to.not.include("grievance");
    });

    it("tells nobody when it was already announced, or isn't routed with a brief yet", async () => {
      announceable.clear();
      expect(await ClientRequestNotifySvc.announce("req-1", NOW)).to.equal(0);
      expect(emitted).to.deep.equal([]);
      expect(emails).to.deep.equal([]);
      expect(notifications).to.deep.equal([]);
    });

    it("keeps telling the others when one lawyer's email fails", async () => {
      (mailerModule as any).sendEmail = async (mail: { to: string }) => {
        if (mail.to === "lawyer-a@example.com") throw new Error("mailbox unavailable");
        emails.push(mail as any);
        return "sent";
      };
      await ClientRequestNotifySvc.announce("req-1", NOW);
      expect(emails.map((e) => e.to)).to.deep.equal(["lawyer-b@example.com"]);
      expect(notifications).to.have.length(2);
    });

    it("announceDue announces every routed request nobody has been told about", async () => {
      announceable = new Set(["req-1", "req-2"]);
      (ClientRequestRepo as any).findUnannounced = async () => [{ id: "req-1" }, { id: "req-2" }, { id: "req-gone" }];
      expect(await ClientRequestNotifySvc.announceDue(NOW)).to.equal(2);
    });
  });

  describe("expireDue", () => {
    let expirable: Set<string>;
    beforeEach(() => {
      expirable = new Set(["req-1", "req-2"]);
      (ClientRequestRepo as any).findExpired = async () => [request("req-1"), request("req-2", { case: { caseAreas: ["FAMILY"], ukJurisdiction: "Scotland" } })];
      (ClientRequestRepo as any).expire = async (id: string) => expirable.delete(id);
    });

    it("expires a request nobody claimed in 48h, and tells its lawyers and the client", async () => {
      expect(await ClientRequestNotifySvc.expireDue(NOW)).to.equal(2);

      const taken = emitted.filter(([, event]) => event === "client-request:taken");
      expect(taken.filter(([, , p]) => p.requestId === "req-1").map(([userId]) => userId)).to.deep.equal(["lawyer-a", "lawyer-b"]);
      const updated = emitted.filter(([, event]) => event === "client-request:updated");
      expect(updated[0]).to.deep.equal(["client-req-1", "client-request:updated", { requestId: "req-1", status: "EXPIRED", updatedAt: NOW.toISOString() }]);
      const toClient = emails.find((e) => e.to === "client-req-1@example.com");
      expect(toClient).to.not.equal(undefined);
      const clientMail = rendered.find((r) => r.name === "client-request-expired-client")!;
      expect(String(clientMail.vars.caseLink)).to.match(/\/cases\/case-req-1$/);
    });

    it("sends ops one digest for the run, listing each expired request", async () => {
      await ClientRequestNotifySvc.expireDue(NOW);

      const toOps = emails.filter((e) => e.to === "ops@example.com");
      expect(toOps).to.have.length(1);
      expect(toOps[0]!.subject).to.equal("2 client requests expired unclaimed");
      const digest = rendered.find((r) => r.name === "client-request-expired-ops")!;
      expect((digest.vars.requests as any[]).map((r) => r.id)).to.deep.equal(["req-1", "req-2"]);
      expect((digest.vars.requests as any[])[1]).to.deep.include({ practiceArea: "Family", ukJurisdiction: "Scotland", matchingLawyers: 2 });
    });

    it("leaves out a request something else moved on, and sends no digest when nothing expired", async () => {
      expirable.clear();
      expect(await ClientRequestNotifySvc.expireDue(NOW)).to.equal(0);
      expect(emails).to.deep.equal([]);
      expect(emitted).to.deep.equal([]);
    });

    it("with no ops address set, still expires but sends no digest", async () => {
      OPS_ALERT_EMAILS.splice(0, OPS_ALERT_EMAILS.length);
      expect(await ClientRequestNotifySvc.expireDue(NOW)).to.equal(2);
      expect(emails.filter((e) => e.to === "ops@example.com")).to.deep.equal([]);
    });
  });

  describe("remindDue", () => {
    const DUE = { id: "claim-1", requestId: "req-1", lawyerId: "lawyer-a", expiresAt: new Date(NOW.getTime() + 2 * HOUR_MS - 60_000), lawyer: { email: "lawyer-a@example.com" } };
    let unsent: Set<string>;
    beforeEach(() => {
      unsent = new Set(["claim-1"]);
      (ClientRequestClaimRepo as any).findDueReminders = async () => [DUE];
      (ClientRequestClaimRepo as any).markReminderSent = async (id: string) => unsent.delete(id);
    });

    it("reminds the lawyer holding it, live and by email, 2h before their hold ends", async () => {
      expect(await ClientRequestNotifySvc.remindDue(NOW)).to.equal(1);

      expect(emitted).to.deep.equal([["lawyer-a", "client-request:claim-expiring", { requestId: "req-1", claimExpiresAt: DUE.expiresAt.toISOString() }]]);
      expect(emails.map((e) => e.to)).to.deep.equal(["lawyer-a@example.com"]);
      expect(rendered[0]!.name).to.equal("client-request-claim-expiring");
    });

    it("never reminds twice", async () => {
      await ClientRequestNotifySvc.remindDue(NOW);
      emitted = [];
      emails = [];
      expect(await ClientRequestNotifySvc.remindDue(NOW)).to.equal(0);
      expect(emitted).to.deep.equal([]);
      expect(emails).to.deep.equal([]);
    });
  });
});
