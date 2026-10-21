/** ClientRequestSweepQueue.tick — the client request timers (#511 adds the first: a claim's 24h hold
 * lapsing). No live Postgres: the claim repo is monkeypatched, same idiom as
 * test/account-deletion-queue.spec.ts. The lapse's own guard runs against the database in
 * test/client-request-claim-repository.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import ClientRequestSweepQueue from "../src/queues/client-request-sweep.queue";
import ClientRequestClaimRepo from "../src/repositories/client-request-claim.repository";
import OrganizationRepo from "../src/repositories/organization.repository";
import NotificationSvc from "../src/services/notification.service";
import SecurityAuditSvc from "../src/services/security-audit.service";
import * as socket from "../src/lib/socket";

/** Saves the named statics so afterEach can put them back. Spreading a class copies none of its
 * static methods, so `{ ...Repo }` would restore nothing. */
function stash<T extends object>(target: T, keys: (keyof T)[]) {
  const saved = keys.map((k) => [k, target[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

const NOW = new Date("2026-10-22T09:00:00.000Z");

const LAPSED = {
  id: "claim-1",
  requestId: "req-1",
  lawyerId: "lawyer-1",
  organizationId: "org-1",
  expiresAt: new Date(NOW.getTime() - 60_000),
  request: { caseId: "case-1", clientId: "client-1" },
};

describe("ClientRequestSweepQueue.tick", () => {
  let restore: (() => void)[];
  let due: (typeof LAPSED)[];
  let lapseWins: boolean;
  let lapsed: { claimId: string; now: Date }[];
  let notifications: any[];
  let emitted: [string, string, any][];
  let securityAudits: any[];
  let audits: any[];

  beforeEach(() => {
    restore = [
      stash(ClientRequestClaimRepo, ["findLapsed", "lapse"]),
      stash(OrganizationRepo, ["writeAudit"]),
      stash(NotificationSvc, ["create"]),
      stash(SecurityAuditSvc, ["record"]),
      stash(socket, ["emitToUser"]),
    ];
    due = [LAPSED];
    lapseWins = true;
    lapsed = [];
    notifications = [];
    emitted = [];
    securityAudits = [];
    audits = [];
    (ClientRequestClaimRepo as any).findLapsed = async (now: Date) => (now >= NOW ? due : []);
    (ClientRequestClaimRepo as any).lapse = async (claim: typeof LAPSED, now: Date) => {
      lapsed.push({ claimId: claim.id, now });
      return lapseWins;
    };
    (OrganizationRepo as any).writeAudit = async (data: any) => audits.push(data);
    (NotificationSvc as any).create = async (input: any) => notifications.push(input);
    (SecurityAuditSvc as any).record = async (input: any) => securityAudits.push(input);
    (socket as any).emitToUser = (userId: string, event: string, payload: unknown) => emitted.push([userId, event, payload]);
  });

  afterEach(() => restore.forEach((r) => r()));

  it("lapses a claim whose 24h hold is over", async () => {
    const result = await ClientRequestSweepQueue.tick(NOW);
    expect(result).to.deep.include({ lapsed: 1 });
    expect(lapsed).to.deep.equal([{ claimId: "claim-1", now: NOW }]);
  });

  it("tells the lawyer their hold ended, in the bell and live, and the client the request moved", async () => {
    await ClientRequestSweepQueue.tick(NOW);

    expect(notifications).to.have.length(1);
    expect(notifications[0]).to.deep.include({ userId: "lawyer-1", type: "CLIENT_REQUEST" });
    expect(notifications[0]).to.not.have.property("organizationId");
    const updates = emitted.filter(([, event]) => event === "client-request:updated");
    expect(updates.map(([userId]) => userId).sort()).to.deep.equal(["client-1", "lawyer-1"]);
    expect(updates[0]![2]).to.deep.equal({ requestId: "req-1", status: "ROUTED", updatedAt: NOW.toISOString() });
  });

  it("records the lapse on the client's case and in the security audit log, with no actor", async () => {
    await ClientRequestSweepQueue.tick(NOW);

    expect(audits[0]).to.deep.include({ caseId: "case-1", action: "client_request.claim_lapsed" });
    expect(securityAudits[0]).to.deep.include({ action: "client_request.claim_lapsed", actorId: null, organizationId: "org-1", caseId: "case-1" });
  });

  it("tells nobody when something else already moved the request on", async () => {
    lapseWins = false;
    const result = await ClientRequestSweepQueue.tick(NOW);

    expect(result).to.deep.include({ lapsed: 0 });
    expect(notifications).to.deep.equal([]);
    expect(emitted).to.deep.equal([]);
    expect(securityAudits).to.deep.equal([]);
  });

  it("keeps going when one lapse fails", async () => {
    due = [{ ...LAPSED, id: "claim-broken" }, LAPSED];
    (ClientRequestClaimRepo as any).lapse = async (claim: typeof LAPSED) => {
      if (claim.id === "claim-broken") throw new Error("connection reset");
      return true;
    };
    expect(await ClientRequestSweepQueue.tick(NOW)).to.deep.include({ lapsed: 1 });
  });
});
