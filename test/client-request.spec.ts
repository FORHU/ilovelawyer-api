/** A client asking for a lawyer (ClientRequestSvc, /api/client/lawyer-requests): only on a UK
 * case that isn't personal injury, one open request per case, the consent version checked, and
 * withdrawing until a lawyer is confirmed. No live Postgres: repositories are monkeypatched, same
 * idiom as test/client-case.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import ClientRequestSvc from "../src/services/client-request.service";
import ClientRequestRepo from "../src/repositories/client-request.repository";
import ClientCaseRepo from "../src/repositories/client-case.repository";
import ClientRequestBriefSvc from "../src/services/client-request-brief.service";
import ClientRequestMatchingSvc from "../src/services/client-request-matching.service";
import * as socket from "../src/lib/socket";
import type { ClientWorkspace } from "../src/services/client-case.service";
import { CLIENT_REQUEST_CONSENT_VERSION } from "../src/constants/client-request.constants";
import { createClientRequestSchema } from "../src/validation/client-request.validation";

async function errorOf(promise: Promise<unknown>): Promise<{ status?: number; code?: string } | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err: any) {
    return { status: err.statusCode, code: err.code };
  }
}

/** Saves the named statics so afterEach can put them back. Spreading a class copies none of its
 * static methods, so `{ ...Repo }` would restore nothing. */
function stash<T extends object>(target: T, keys: (keyof T)[]) {
  const saved = keys.map((k) => [k, target[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

const workspace: ClientWorkspace = { id: "org-personal", role: "OWNER", tenantCode: "UK" };
const CASE_ID = "11111111-1111-4111-8111-111111111111";

describe("Client lawyer requests", () => {
  let restore: (() => void)[];
  let briefsStarted: string[];
  let caseRow: any;
  let open: { id: string } | null;
  let requests: Map<string, any>;
  let claims: any[];
  let emitted: [string, string, any][];

  beforeEach(() => {
    restore = [
      stash(ClientCaseRepo, ["findById"]),
      stash(ClientRequestRepo, ["findOpenForCase", "create", "findForClient", "transition", "route", "withdraw"]),
      stash(ClientRequestBriefSvc, ["generateInBackground"]),
      stash(ClientRequestMatchingSvc, ["eligibleLawyerIds"]),
      stash(socket, ["emitToUser"]),
    ];
    claims = [];
    emitted = [];
    (ClientRequestMatchingSvc as any).eligibleLawyerIds = async () => ["lawyer-a", "lawyer-b"];
    (socket as any).emitToUser = (userId: string, event: string, payload: unknown) => emitted.push([userId, event, payload]);
    (ClientRequestRepo as any).withdraw = async (id: string, from: string[], now: Date) => {
      const r = requests.get(id);
      if (!r || !from.includes(r.status)) return { moved: false, heldBy: [] };
      const open = claims.filter((c) => c.requestId === id && c.outcome === null);
      for (const c of open) Object.assign(c, { outcome: "WITHDRAWN", endedAt: now });
      Object.assign(r, { status: "WITHDRAWN", withdrawnAt: now });
      return { moved: true, heldBy: open.map((c) => c.lawyerId) };
    };
    caseRow = { id: CASE_ID, ukJurisdiction: "England and Wales", lawyerReadiness: null };
    open = null;
    requests = new Map();
    briefsStarted = [];
    (ClientRequestBriefSvc as any).generateInBackground = (id: string) => briefsStarted.push(id);
    (ClientCaseRepo as any).findById = async (id: string, orgId: string) => (caseRow && id === caseRow.id && orgId === workspace.id ? caseRow : null);
    (ClientRequestRepo as any).findOpenForCase = async () => open;
    (ClientRequestRepo as any).create = async (data: any) => {
      const row = { id: `req-${requests.size + 1}`, status: "REQUESTED", withdrawnAt: null, createdAt: new Date(), updatedAt: new Date(), ...data };
      requests.set(row.id, row);
      return row;
    };
    (ClientRequestRepo as any).findForClient = async (id: string, clientId: string) => {
      const r = requests.get(id);
      // The real repository includes the quoting claim (#512); none in this world.
      return r && r.clientId === clientId ? { claims: [], ...r } : null;
    };
    (ClientRequestRepo as any).transition = async (id: string, from: string[], data: any) => {
      const r = requests.get(id);
      if (!r || !from.includes(r.status)) return false;
      Object.assign(r, data);
      return true;
    };
    (ClientRequestRepo as any).route = async (id: string) => {
      const r = requests.get(id);
      Object.assign(r, { status: "ROUTED", routingExpiresAt: new Date() });
      return r;
    };
  });
  afterEach(() => restore.forEach((r) => r()));

  const ask = (overrides: Record<string, unknown> = {}) =>
    ClientRequestSvc.create(workspace, "client-1", { caseId: CASE_ID, note: "  Prefer a fixed fee. ", consentVersion: CLIENT_REQUEST_CONSENT_VERSION, consentAccepted: true, ...overrides });

  describe("eligibility", () => {
    it("is eligible on a UK case with no open request (cases are free, so there's no payment to check)", async () => {
      expect(await ClientRequestSvc.eligibility(workspace, CASE_ID)).to.deep.equal({ eligible: true, reason: null, openRequestId: null });
    });

    it("says why not, in order: outside the UK, personal injury, already asked", async () => {
      caseRow.ukJurisdiction = null;
      expect((await ClientRequestSvc.eligibility(workspace, CASE_ID)).reason).to.equal("NOT_UK_CASE");
      caseRow.ukJurisdiction = "Scotland";
      caseRow.lawyerReadiness = { blockedBy: "PERSONAL_INJURY" };
      expect((await ClientRequestSvc.eligibility(workspace, CASE_ID)).reason).to.equal("PERSONAL_INJURY_EXCLUDED");
      caseRow.lawyerReadiness = null;
      open = { id: "req-9" };
      expect(await ClientRequestSvc.eligibility(workspace, CASE_ID)).to.deep.equal({ eligible: false, reason: "REQUEST_ALREADY_OPEN", openRequestId: "req-9" });
    });

    it("answers 404 for someone else's case", async () => {
      caseRow = null;
      expect(await errorOf(ClientRequestSvc.eligibility(workspace, CASE_ID))).to.deep.equal({ status: 404, code: undefined });
    });
  });

  describe("create", () => {
    it("records the request with the consent version and time, and the trimmed note", async () => {
      const before = Date.now();
      const dto = await ask();
      expect(dto).to.include({ caseId: CASE_ID, status: "ROUTED", note: "Prefer a fixed fee.", consentVersion: CLIENT_REQUEST_CONSENT_VERSION, lawyer: null, quote: null });
      expect(new Date(dto.consentAcceptedAt).getTime()).to.be.at.least(before);
      expect(briefsStarted).to.deep.equal([dto.id]);
    });

    it("needs the consent ticked, and the current version of it", async () => {
      expect(await errorOf(ask({ consentAccepted: false }))).to.deep.equal({ status: 400, code: "CONSENT_REQUIRED" });
      expect(await errorOf(ask({ consentVersion: "2020-01-01" }))).to.deep.equal({ status: 409, code: "CONSENT_VERSION_STALE" });
      expect(requests.size).to.equal(0);
      expect(briefsStarted).to.deep.equal([]);
    });

    it("refuses with a clear reason when the case isn't eligible", async () => {
      caseRow.ukJurisdiction = null;
      expect(await errorOf(ask())).to.deep.equal({ status: 422, code: "NOT_UK_CASE" });
      caseRow.ukJurisdiction = "Northern Ireland";
      open = { id: "req-9" };
      expect(await errorOf(ask())).to.deep.equal({ status: 409, code: "REQUEST_ALREADY_OPEN" });
    });
  });

  describe("withdraw", () => {
    it("takes the request back before a lawyer is confirmed", async () => {
      const { id } = await ask();
      const dto = await ClientRequestSvc.withdraw("client-1", id);
      expect(dto.status).to.equal("WITHDRAWN");
      expect(requests.get(id).withdrawnAt).to.be.instanceOf(Date);
    });

    it("refuses once the lawyer is confirmed, saying what state it's in", async () => {
      const { id } = await ask();
      requests.get(id).status = "ENGAGED";
      expect(await errorOf(ClientRequestSvc.withdraw("client-1", id))).to.deep.equal({ status: 409, code: "INVALID_REQUEST_STATUS" });
    });

    it("never touches another client's request", async () => {
      const { id } = await ask();
      expect(await errorOf(ClientRequestSvc.withdraw("client-2", id))).to.deep.include({ status: 404 });
      expect(await errorOf(ClientRequestSvc.get("client-2", id))).to.deep.include({ status: 404 });
    });

    it("tells the lawyers who could see it in their inbox that it's gone", async () => {
      const { id } = await ask();
      await ClientRequestSvc.withdraw("client-1", id);

      expect(emitted.map(([userId, event]) => [userId, event])).to.deep.equal([
        ["lawyer-a", "client-request:taken"],
        ["lawyer-b", "client-request:taken"],
      ]);
      expect(emitted[0]![2]).to.deep.equal({ requestId: id });
    });

    it("ends the claim of every lawyer on it and tells them; the others just lose it from their inbox", async () => {
      const { id } = await ask();
      claims.push({ requestId: id, lawyerId: "lawyer-a", outcome: null }, { requestId: id, lawyerId: "lawyer-c", outcome: null });

      await ClientRequestSvc.withdraw("client-1", id);

      expect(claims.map((c) => c.outcome)).to.deep.equal(["WITHDRAWN", "WITHDRAWN"]);
      expect(emitted.map(([userId, event]) => [userId, event])).to.deep.equal([
        ["lawyer-a", "client-request:updated"],
        ["lawyer-c", "client-request:updated"],
        ["lawyer-b", "client-request:taken"],
      ]);
      expect(emitted[0]![2]).to.deep.include({ requestId: id, status: "WITHDRAWN" });
    });
  });

  // Review finding 7 (client #68): the app only says more quotes may come while they can.
  describe("openToLawyers", () => {
    const HOUR = 60 * 60 * 1000;
    const stored = (overrides: Record<string, unknown>, open: number) => {
      requests.set("req-x", { id: "req-x", caseId: CASE_ID, clientId: "client-1", status: "ROUTED", routingExpiresAt: new Date(Date.now() + HOUR), pickByAt: null, createdAt: new Date(), ...overrides });
      const lawyer = { id: "l", name: "L", username: "l", lawyerClientProfile: null };
      (ClientRequestRepo as any).findForClient = async () => ({
        ...requests.get("req-x"),
        claims: Array.from({ length: open }, (_, i) => ({ id: `c${i}`, lawyerId: `l${i}`, outcome: null, quotedAt: null, claimedAt: new Date(), lawyer })),
      });
    };

    it("is true while the 48h are open and a place is free", async () => {
      stored({}, 2);
      expect((await ClientRequestSvc.get("client-1", "req-x")).openToLawyers).to.equal(true);
    });

    it("is false once 3 lawyers are on it, once the 48h are over, or once it isn't ROUTED", async () => {
      stored({}, 3);
      expect((await ClientRequestSvc.get("client-1", "req-x")).openToLawyers).to.equal(false);
      stored({ routingExpiresAt: new Date(Date.now() - HOUR) }, 1);
      expect((await ClientRequestSvc.get("client-1", "req-x")).openToLawyers).to.equal(false);
      stored({ status: "CONFIRMED" }, 1);
      expect((await ClientRequestSvc.get("client-1", "req-x")).openToLawyers).to.equal(false);
    });
  });

  it("validates the note length and the case id", () => {
    const base = { caseId: CASE_ID, consentVersion: "v", consentAccepted: true };
    expect(createClientRequestSchema.validate(base).error).to.equal(undefined);
    expect(createClientRequestSchema.validate({ ...base, note: "x".repeat(1001) }).error).to.not.equal(undefined);
    expect(createClientRequestSchema.validate({ ...base, caseId: "nope" }).error).to.not.equal(undefined);
  });
});
