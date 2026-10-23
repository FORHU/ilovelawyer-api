/** A client asking for a lawyer (ClientRequestSvc, /api/client/lawyer-requests): only on a paid UK
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
  let paid: boolean;
  let open: { id: string } | null;
  let slots: { id: string; caseId: string; status: string; createdAt: Date; case: { caseName: string } }[];
  let requests: Map<string, any>;
  let claims: any[];
  let emitted: [string, string, any][];

  beforeEach(() => {
    restore = [
      stash(ClientCaseRepo, ["findById"]),
      stash(ClientRequestRepo, ["hasCasePayment", "findOpenForCase", "listOpenForClient", "create", "findForClient", "transition", "route", "withdraw"]),
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
      if (!r || !from.includes(r.status)) return { moved: false, heldBy: null };
      const open = claims.find((c) => c.requestId === id && c.outcome === null);
      if (open) Object.assign(open, { outcome: "WITHDRAWN", endedAt: now });
      Object.assign(r, { status: "WITHDRAWN", withdrawnAt: now });
      return { moved: true, heldBy: open?.lawyerId ?? null };
    };
    caseRow = { id: CASE_ID, ukJurisdiction: "England and Wales", lawyerReadiness: null };
    paid = true;
    open = null;
    slots = [];
    requests = new Map();
    briefsStarted = [];
    (ClientRequestBriefSvc as any).generateInBackground = (id: string) => briefsStarted.push(id);
    (ClientCaseRepo as any).findById = async (id: string, orgId: string) => (caseRow && id === caseRow.id && orgId === workspace.id ? caseRow : null);
    (ClientRequestRepo as any).hasCasePayment = async () => paid;
    (ClientRequestRepo as any).findOpenForCase = async () => open;
    (ClientRequestRepo as any).listOpenForClient = async () => slots;
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
    it("is eligible on a paid UK case with no open request", async () => {
      expect(await ClientRequestSvc.eligibility(workspace, CASE_ID, "client-1")).to.deep.equal({ eligible: true, reason: null, openRequestId: null });
    });

    it("says why not, in order: outside the UK, personal injury, unpaid, already asked", async () => {
      caseRow.ukJurisdiction = null;
      expect((await ClientRequestSvc.eligibility(workspace, CASE_ID, "client-1")).reason).to.equal("NOT_UK_CASE");
      caseRow.ukJurisdiction = "Scotland";
      caseRow.lawyerReadiness = { blockedBy: "PERSONAL_INJURY" };
      expect((await ClientRequestSvc.eligibility(workspace, CASE_ID, "client-1")).reason).to.equal("PERSONAL_INJURY_EXCLUDED");
      caseRow.lawyerReadiness = null;
      paid = false;
      expect((await ClientRequestSvc.eligibility(workspace, CASE_ID, "client-1")).reason).to.equal("CASE_NOT_PAID");
      paid = true;
      open = { id: "req-9" };
      expect(await ClientRequestSvc.eligibility(workspace, CASE_ID, "client-1")).to.deep.equal({ eligible: false, reason: "REQUEST_ALREADY_OPEN", openRequestId: "req-9" });
    });

    it("answers 404 for someone else's case", async () => {
      caseRow = null;
      expect(await errorOf(ClientRequestSvc.eligibility(workspace, CASE_ID, "client-1"))).to.deep.equal({ status: 404, code: undefined });
    });

    describe("request slots", () => {
      const slot = (n: number, status: string) => ({ id: `req-${n}`, caseId: `case-${n}`, status, createdAt: new Date(), case: { caseName: `Case ${n}` } });

      it("is eligible while a slot is free", async () => {
        slots = [slot(1, "ROUTED"), slot(2, "QUOTED")];
        expect((await ClientRequestSvc.eligibility(workspace, CASE_ID, "client-1", 3)).eligible).to.equal(true);
      });

      it("is full at the limit, listing what holds each slot and which can be withdrawn", async () => {
        slots = [slot(1, "ROUTED"), slot(2, "ENGAGED"), slot(3, "CONFIRMED")];
        const check = await ClientRequestSvc.eligibility(workspace, CASE_ID, "client-1", 3);
        expect(check).to.include({ eligible: false, reason: "REQUEST_LIMIT_REACHED", openRequestId: null });
        expect(check.limit!.max).to.equal(3);
        expect(check.limit!.open.map((r) => [r.requestId, r.caseTitle, r.canWithdraw])).to.deep.equal([
          ["req-1", "Case 1", true],
          ["req-2", "Case 2", false],
          ["req-3", "Case 3", false],
        ]);
      });

      it("has no limit at 0", async () => {
        slots = [slot(1, "ROUTED"), slot(2, "ROUTED"), slot(3, "ROUTED"), slot(4, "ROUTED")];
        expect((await ClientRequestSvc.eligibility(workspace, CASE_ID, "client-1", 0)).eligible).to.equal(true);
      });

      it("reports a case that already has a request before the limit", async () => {
        slots = [slot(1, "ROUTED")];
        open = { id: "req-1" };
        expect((await ClientRequestSvc.eligibility(workspace, CASE_ID, "client-1", 1)).reason).to.equal("REQUEST_ALREADY_OPEN");
      });

      it("refuses create with 409 when the last slot is taken between the check and the insert", async () => {
        (ClientRequestRepo as any).create = async () => null;
        expect(await errorOf(ask())).to.deep.equal({ status: 409, code: "REQUEST_LIMIT_REACHED" });
        expect(briefsStarted).to.deep.equal([]);
      });
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

    it("while a lawyer holds it, ends their claim and tells them", async () => {
      const { id } = await ask();
      requests.get(id).status = "CLAIMED";
      claims.push({ requestId: id, lawyerId: "lawyer-a", outcome: null });

      await ClientRequestSvc.withdraw("client-1", id);

      expect(claims[0].outcome).to.equal("WITHDRAWN");
      expect(emitted).to.have.length(1);
      expect(emitted[0]!.slice(0, 2)).to.deep.equal(["lawyer-a", "client-request:updated"]);
      expect(emitted[0]![2]).to.deep.include({ requestId: id, status: "WITHDRAWN" });
    });
  });

  it("validates the note length and the case id", () => {
    const base = { caseId: CASE_ID, consentVersion: "v", consentAccepted: true };
    expect(createClientRequestSchema.validate(base).error).to.equal(undefined);
    expect(createClientRequestSchema.validate({ ...base, note: "x".repeat(1001) }).error).to.not.equal(undefined);
    expect(createClientRequestSchema.validate({ ...base, caseId: "nope" }).error).to.not.equal(undefined);
  });
});
