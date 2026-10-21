/** ClientRequestLawyerSvc — the lawyer app's side of client requests (#511): the inbox, accepting
 * (claiming) a request for 24h, and passing on one. No live Postgres: repositories are
 * monkeypatched with an in-memory world, same idiom as test/client-request.spec.ts. The race
 * itself is proven against the database in test/client-request-claim-repository.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import ClientRequestLawyerSvc, { type LawyerContext } from "../src/services/client-request-lawyer.service";
import ClientRequestRepo from "../src/repositories/client-request.repository";
import ClientRequestClaimRepo from "../src/repositories/client-request-claim.repository";
import LawyerProfileRepo from "../src/repositories/lawyer-profile.repository";
import OrganizationRepo from "../src/repositories/organization.repository";
import ClientRequestBriefSvc from "../src/services/client-request-brief.service";
import SecurityAuditSvc from "../src/services/security-audit.service";
import * as socket from "../src/lib/socket";

const HOUR_MS = 60 * 60 * 1000;

/** Saves the named statics so afterEach can put them back. Spreading a class copies none of its
 * static methods, so `{ ...Repo }` would restore nothing. */
function stash<T extends object>(target: T, keys: (keyof T)[]) {
  const saved = keys.map((k) => [k, target[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

async function errorOf(promise: Promise<unknown>): Promise<{ status?: number; code?: string; details?: any } | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err: any) {
    return { status: err.statusCode, code: err.code, details: err.details };
  }
}

const me: LawyerContext = { userId: "lawyer-me", organizationId: "org-me", tenantCode: "UK" };

const PROFILE = {
  userId: "lawyer-me",
  verificationStatus: "VERIFIED",
  acceptingRequests: true,
  enabledByOrganization: true,
  pausedUntil: null as Date | null,
  practiceAreas: ["EMPLOYMENT"],
  qualifiedJurisdictions: ["England and Wales"],
};

const BRIEF = { summary: "Dismissed after raising a grievance.", practiceArea: "EMPLOYMENT", ukJurisdiction: "England and Wales", urgency: "SOON" };

describe("ClientRequestLawyerSvc", () => {
  let restore: (() => void)[];

  let requests: Map<string, any>;
  let claims: any[];
  let profiles: Map<string, any>;
  let roles: Map<string, string>;
  let emitted: [string, string, any][];
  let audits: any[];
  let securityAudits: any[];

  /** A request routed 1h ago to the case's practice area and jurisdiction. */
  function routed(id: string, overrides: Record<string, unknown> = {}) {
    const row = {
      id,
      caseId: `case-${id}`,
      clientId: `client-${id}`,
      status: "ROUTED",
      brief: BRIEF,
      routedAt: new Date(Date.now() - HOUR_MS),
      routingExpiresAt: new Date(Date.now() + 47 * HOUR_MS),
      excludedLawyerIds: [] as string[],
      createdAt: new Date(Date.now() - HOUR_MS),
      updatedAt: new Date(),
      case: { practiceArea: "EMPLOYMENT", ukJurisdiction: "England and Wales" },
      ...overrides,
    };
    requests.set(id, row);
    return row;
  }

  /** The lawyers who'd currently match a request: every verified, matching profile not excluded. */
  function matchingLawyers(r: any) {
    return [...profiles.values()]
      .filter((p) => p.verificationStatus === "VERIFIED" && p.acceptingRequests && !r.excludedLawyerIds.includes(p.userId))
      .filter((p) => p.practiceAreas.includes(r.case.practiceArea) && p.qualifiedJurisdictions.includes(r.case.ukJurisdiction))
      .map((p) => p.userId);
  }

  const withClaims = (r: any) => ({ ...r, claims: claims.filter((c) => c.requestId === r.id).map((c) => ({ ...c, lawyer: { id: c.lawyerId, name: `Name of ${c.lawyerId}` } })) });

  beforeEach(() => {
    restore = [
      stash(ClientRequestRepo, ["findForMatching", "findForLawyer", "listRoutedFor", "listHeldBy", "exclude"]),
      stash(ClientRequestClaimRepo, ["claim"]),
      stash(LawyerProfileRepo, ["find", "findLawyerTenant", "findVerified"]),
      stash(OrganizationRepo, ["writeAudit"]),
      stash(SecurityAuditSvc, ["record"]),
      stash(ClientRequestBriefSvc, ["current"]),
      stash(socket, ["emitToUser"]),
    ];
    requests = new Map();
    claims = [];
    profiles = new Map([
      ["lawyer-me", { ...PROFILE }],
      ["lawyer-other", { ...PROFILE, userId: "lawyer-other" }],
      ["lawyer-third", { ...PROFILE, userId: "lawyer-third" }],
    ]);
    roles = new Map([
      ["lawyer-me", "LAWYER"],
      ["lawyer-other", "LAWYER"],
      ["lawyer-third", "LAWYER"],
      ["client-x", "USER"],
    ]);
    emitted = [];
    audits = [];
    securityAudits = [];

    (LawyerProfileRepo as any).find = async (userId: string) => profiles.get(userId) ?? null;
    (LawyerProfileRepo as any).findLawyerTenant = async (userId: string) => (roles.has(userId) ? { role: roles.get(userId), tenantCode: "UK" } : null);
    (LawyerProfileRepo as any).findVerified = async (exclude: string[]) =>
      [...profiles.values()].filter((p) => p.verificationStatus === "VERIFIED" && !exclude.includes(p.userId));
    (ClientRequestRepo as any).findForMatching = async (id: string) => {
      const r = requests.get(id);
      return r ? { excludedLawyerIds: r.excludedLawyerIds, case: r.case } : null;
    };
    (ClientRequestRepo as any).findForLawyer = async (id: string) => {
      const r = requests.get(id);
      return r ? withClaims(r) : null;
    };
    (ClientRequestRepo as any).listRoutedFor = async (lawyerId: string, areas: { practiceAreas: string[]; jurisdictions: string[] }, now: Date) =>
      [...requests.values()]
        .filter((r) => r.status === "ROUTED" && r.brief && r.routingExpiresAt > now && !r.excludedLawyerIds.includes(lawyerId))
        .filter((r) => areas.practiceAreas.includes(r.case.practiceArea) && areas.jurisdictions.includes(r.case.ukJurisdiction))
        .sort((a, b) => b.routedAt - a.routedAt)
        .map(withClaims);
    (ClientRequestRepo as any).listHeldBy = async (lawyerId: string, view: "mine" | "history", page: number, limit: number) => {
      const held = [...requests.values()].filter((r) =>
        claims.some((c) => c.requestId === r.id && c.lawyerId === lawyerId && (view === "mine" ? c.outcome === null || (c.outcome === "ENGAGED" && r.status === "ENGAGED") : c.outcome !== null && !(c.outcome === "ENGAGED" && r.status === "ENGAGED")))
      );
      return { total: held.length, data: held.slice((page - 1) * limit, page * limit).map(withClaims) };
    };
    (ClientRequestRepo as any).exclude = async (id: string, lawyerId: string) => {
      const r = requests.get(id);
      if (r && !r.excludedLawyerIds.includes(lawyerId)) r.excludedLawyerIds.push(lawyerId);
    };
    (ClientRequestClaimRepo as any).claim = async (requestId: string, lawyerId: string, organizationId: string, now: Date = new Date()) => {
      const r = requests.get(requestId);
      if (!r || r.status !== "ROUTED" || r.routingExpiresAt <= now || r.excludedLawyerIds.includes(lawyerId)) return null;
      r.status = "CLAIMED";
      r.updatedAt = now;
      const claim = { id: `claim-${claims.length + 1}`, requestId, lawyerId, organizationId, claimedAt: now, expiresAt: new Date(now.getTime() + 24 * HOUR_MS), outcome: null, endedAt: null };
      claims.push(claim);
      return claim;
    };
    (OrganizationRepo as any).writeAudit = async (data: any) => audits.push(data);
    (SecurityAuditSvc as any).record = async (input: any) => securityAudits.push(input);
    (ClientRequestBriefSvc as any).current = async (id: string) => requests.get(id)?.brief ?? null;
    (socket as any).emitToUser = (userId: string, event: string, payload: unknown) => emitted.push([userId, event, payload]);
  });

  afterEach(() => restore.forEach((r) => r()));

  describe("who can use it", () => {
    it("refuses an account that isn't a lawyer", async () => {
      roles.set("lawyer-me", "USER");
      expect(await errorOf(ClientRequestLawyerSvc.list(me, { view: "inbox", page: 1, limit: 20 }))).to.deep.include({ status: 403 });
    });

    it("refuses a lawyer working outside the UK", async () => {
      const err = await errorOf(ClientRequestLawyerSvc.list({ ...me, tenantCode: "PH" }, { view: "inbox", page: 1, limit: 20 }));
      expect(err).to.deep.include({ status: 403, code: "NOT_UK_TENANT" });
    });

    it("refuses a lawyer who isn't verified yet", async () => {
      profiles.get("lawyer-me")!.verificationStatus = "PENDING";
      const err = await errorOf(ClientRequestLawyerSvc.claim(me, routed("req-1").id));
      expect(err).to.deep.include({ status: 403, code: "LAWYER_NOT_VERIFIED" });
    });
  });

  describe("claim", () => {
    it("holds the request for 24h and shows it as theirs", async () => {
      routed("req-1");
      const dto = await ClientRequestLawyerSvc.claim(me, "req-1");

      expect(dto.status).to.equal("CLAIMED");
      expect(dto.claim).to.deep.include({ byMe: true, lawyer: { id: "lawyer-me", name: "Name of lawyer-me" } });
      expect(dto.claim!.claimExpiresAt.getTime() - dto.claim!.claimedAt.getTime()).to.equal(24 * HOUR_MS);
      expect(claims[0]).to.deep.include({ lawyerId: "lawyer-me", organizationId: "org-me" });
    });

    it("tells the other matching lawyers it's taken, and the client it moved", async () => {
      routed("req-1");
      await ClientRequestLawyerSvc.claim(me, "req-1");

      const taken = emitted.filter(([, event]) => event === "client-request:taken");
      expect(taken.map(([userId]) => userId).sort()).to.deep.equal(["lawyer-other", "lawyer-third"]);
      expect(taken[0]![2]).to.deep.equal({ requestId: "req-1" });
      const updated = emitted.filter(([, event]) => event === "client-request:updated");
      expect(updated.map(([userId]) => userId)).to.deep.equal(["client-req-1"]);
      expect(updated[0]![2]).to.deep.include({ requestId: "req-1", status: "CLAIMED" });
    });

    it("records the claim on the client's case and in the security audit log", async () => {
      routed("req-1");
      await ClientRequestLawyerSvc.claim(me, "req-1");

      expect(audits).to.have.length(1);
      expect(audits[0]).to.deep.include({ caseId: "case-req-1", actorId: "lawyer-me", action: "client_request.claimed" });
      expect(securityAudits).to.have.length(1);
      expect(securityAudits[0]).to.deep.include({ action: "client_request.claimed", actorId: "lawyer-me", organizationId: "org-me", caseId: "case-req-1" });
    });

    it("answers REQUEST_ALREADY_CLAIMED when another lawyer won", async () => {
      routed("req-1");
      await ClientRequestLawyerSvc.claim({ ...me, userId: "lawyer-other" }, "req-1");

      expect(await errorOf(ClientRequestLawyerSvc.claim(me, "req-1"))).to.deep.include({ status: 409, code: "REQUEST_ALREADY_CLAIMED" });
    });

    it("answers INVALID_REQUEST_STATUS, with the status, once the request has ended", async () => {
      routed("req-1", { status: "WITHDRAWN" });
      const err = await errorOf(ClientRequestLawyerSvc.claim(me, "req-1"));
      expect(err).to.deep.include({ status: 409, code: "INVALID_REQUEST_STATUS" });
      expect(err!.details).to.deep.equal({ status: "WITHDRAWN" });
    });

    it("answers INVALID_REQUEST_STATUS once the 48h window is over, before the sweep expires it", async () => {
      routed("req-1", { routingExpiresAt: new Date(Date.now() - 1000) });
      expect(await errorOf(ClientRequestLawyerSvc.claim(me, "req-1"))).to.deep.include({ status: 409, code: "INVALID_REQUEST_STATUS" });
    });

    it("answers 404 for a request the lawyer doesn't match", async () => {
      routed("req-1", { case: { practiceArea: "FAMILY", ukJurisdiction: "England and Wales" } });
      expect(await errorOf(ClientRequestLawyerSvc.claim(me, "req-1"))).to.deep.include({ status: 404 });
      expect(claims).to.have.length(0);
    });

    it("answers 404 for a request the lawyer passed on", async () => {
      routed("req-1", { excludedLawyerIds: ["lawyer-me"] });
      expect(await errorOf(ClientRequestLawyerSvc.claim(me, "req-1"))).to.deep.include({ status: 404 });
    });

    it("answers 404 for no such request", async () => {
      expect(await errorOf(ClientRequestLawyerSvc.claim(me, "nope"))).to.deep.include({ status: 404 });
    });
  });

  describe("pass", () => {
    const inboxIds = async (lawyer: LawyerContext) => (await ClientRequestLawyerSvc.list(lawyer, { view: "inbox", page: 1, limit: 20 })).data.map((r) => r.id);

    it("hides the request from that lawyer's inbox and nobody else's", async () => {
      routed("req-1");
      await ClientRequestLawyerSvc.pass(me, "req-1");

      expect(await inboxIds(me)).to.deep.equal([]);
      expect(await inboxIds({ ...me, userId: "lawyer-other" })).to.deep.equal(["req-1"]);
      expect(requests.get("req-1")!.status).to.equal("ROUTED");
    });

    it("can't be claimed after passing", async () => {
      routed("req-1");
      await ClientRequestLawyerSvc.pass(me, "req-1");
      expect(await errorOf(ClientRequestLawyerSvc.claim(me, "req-1"))).to.deep.include({ status: 404 });
    });

    it("refuses a pass on a request the lawyer holds: that's a release", async () => {
      routed("req-1");
      await ClientRequestLawyerSvc.claim(me, "req-1");
      expect(await errorOf(ClientRequestLawyerSvc.pass(me, "req-1"))).to.deep.include({ status: 409, code: "INVALID_REQUEST_STATUS" });
    });

    it("answers 404 for a request not for them", async () => {
      routed("req-1", { case: { practiceArea: "FAMILY", ukJurisdiction: "England and Wales" } });
      expect(await errorOf(ClientRequestLawyerSvc.pass(me, "req-1"))).to.deep.include({ status: 404 });
    });
  });

  describe("list", () => {
    const view = (v: "inbox" | "mine" | "history", lawyer = me, page = 1, limit = 20) => ClientRequestLawyerSvc.list(lawyer, { view: v, page, limit });

    it("inbox: routed to them, newest first, unclaimed, with a brief, inside the 48h", async () => {
      routed("older", { routedAt: new Date(Date.now() - 3 * HOUR_MS) });
      routed("newer");
      routed("other-area", { case: { practiceArea: "FAMILY", ukJurisdiction: "England and Wales" } });
      routed("no-brief-yet", { brief: null });
      routed("window-over", { routingExpiresAt: new Date(Date.now() - 1000) });
      routed("claimed", { status: "CLAIMED" });

      const inbox = await view("inbox");
      expect(inbox.data.map((r) => r.id)).to.deep.equal(["newer", "older"]);
      expect(inbox.total).to.equal(2);
      expect(inbox.data[0]).to.deep.include({ status: "ROUTED", claim: null, brief: BRIEF });
    });

    it("inbox: pages through what's routed to them", async () => {
      for (let i = 0; i < 3; i++) routed(`req-${i}`, { routedAt: new Date(Date.now() - i * HOUR_MS) });
      const second = await view("inbox", me, 2, 2);
      expect(second).to.deep.include({ total: 3 });
      expect(second.data.map((r) => r.id)).to.deep.equal(["req-2"]);
    });

    it("inbox: empty while the lawyer isn't accepting requests", async () => {
      routed("req-1");
      profiles.get("lawyer-me")!.acceptingRequests = false;
      expect((await view("inbox")).data).to.deep.equal([]);
    });

    it("mine: the request they hold; history: the hold that lapsed", async () => {
      routed("held");
      routed("lapsed");
      await ClientRequestLawyerSvc.claim(me, "held");
      await ClientRequestLawyerSvc.claim(me, "lapsed");
      Object.assign(claims.find((c) => c.requestId === "lapsed"), { outcome: "LAPSED", endedAt: new Date() });
      Object.assign(requests.get("lapsed"), { status: "ROUTED", excludedLawyerIds: ["lawyer-me"] });

      const mine = await view("mine");
      expect(mine.data.map((r) => r.id)).to.deep.equal(["held"]);
      expect(mine.data[0]!.claim).to.deep.include({ byMe: true });
      expect((await view("history")).data.map((r) => r.id)).to.deep.equal(["lapsed"]);
      expect((await view("inbox")).data).to.deep.equal([]);
    });
  });

  describe("get", () => {
    it("shows a routed request they match, with its current brief", async () => {
      routed("req-1");
      const dto = await ClientRequestLawyerSvc.get(me, "req-1");
      expect(dto).to.deep.include({ id: "req-1", status: "ROUTED", brief: BRIEF, claim: null });
    });

    it("shows a request they hold", async () => {
      routed("req-1");
      await ClientRequestLawyerSvc.claim(me, "req-1");
      expect((await ClientRequestLawyerSvc.get(me, "req-1")).status).to.equal("CLAIMED");
    });

    it("answers 404 for a request another lawyer holds", async () => {
      routed("req-1");
      await ClientRequestLawyerSvc.claim({ ...me, userId: "lawyer-other" }, "req-1");
      expect(await errorOf(ClientRequestLawyerSvc.get(me, "req-1"))).to.deep.include({ status: 404 });
    });

    it("answers 404 for a request they passed on", async () => {
      routed("req-1", { excludedLawyerIds: ["lawyer-me"] });
      expect(await errorOf(ClientRequestLawyerSvc.get(me, "req-1"))).to.deep.include({ status: 404 });
    });
  });
});
