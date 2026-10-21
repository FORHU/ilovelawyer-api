/** A client asking for a lawyer (ClientRequestSvc, /api/client/lawyer-requests): only on a paid UK
 * case that isn't personal injury, one open request per case, the consent version checked, and
 * withdrawing until a lawyer is confirmed. No live Postgres: repositories are monkeypatched, same
 * idiom as test/client-case.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import ClientRequestSvc from "../src/services/client-request.service";
import ClientRequestRepo from "../src/repositories/client-request.repository";
import ClientCaseRepo from "../src/repositories/client-case.repository";
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

const workspace: ClientWorkspace = { id: "org-personal", role: "OWNER", tenantCode: "UK" };
const CASE_ID = "11111111-1111-4111-8111-111111111111";

describe("Client lawyer requests", () => {
  const originals = {
    caseFind: ClientCaseRepo.findById,
    repo: { ...ClientRequestRepo } as Record<string, unknown>,
  };
  let caseRow: any;
  let paid: boolean;
  let open: { id: string } | null;
  let requests: Map<string, any>;

  beforeEach(() => {
    caseRow = { id: CASE_ID, ukJurisdiction: "England and Wales", lawyerReadiness: null };
    paid = true;
    open = null;
    requests = new Map();
    (ClientCaseRepo as any).findById = async (id: string, orgId: string) => (caseRow && id === caseRow.id && orgId === workspace.id ? caseRow : null);
    (ClientRequestRepo as any).hasCasePayment = async () => paid;
    (ClientRequestRepo as any).findOpenForCase = async () => open;
    (ClientRequestRepo as any).create = async (data: any) => {
      const row = { id: `req-${requests.size + 1}`, status: "REQUESTED", withdrawnAt: null, createdAt: new Date(), updatedAt: new Date(), ...data };
      requests.set(row.id, row);
      return row;
    };
    (ClientRequestRepo as any).findForClient = async (id: string, clientId: string) => {
      const r = requests.get(id);
      return r && r.clientId === clientId ? r : null;
    };
    (ClientRequestRepo as any).transition = async (id: string, from: string[], data: any) => {
      const r = requests.get(id);
      if (!r || !from.includes(r.status)) return false;
      Object.assign(r, data);
      return true;
    };
  });
  afterEach(() => {
    (ClientCaseRepo as any).findById = originals.caseFind;
    Object.assign(ClientRequestRepo, originals.repo);
  });

  const ask = (overrides: Record<string, unknown> = {}) =>
    ClientRequestSvc.create(workspace, "client-1", { caseId: CASE_ID, note: "  Prefer a fixed fee. ", consentVersion: CLIENT_REQUEST_CONSENT_VERSION, consentAccepted: true, ...overrides });

  describe("eligibility", () => {
    it("is eligible on a paid UK case with no open request", async () => {
      expect(await ClientRequestSvc.eligibility(workspace, CASE_ID)).to.deep.equal({ eligible: true, reason: null, openRequestId: null });
    });

    it("says why not, in order: outside the UK, personal injury, unpaid, already asked", async () => {
      caseRow.ukJurisdiction = null;
      expect((await ClientRequestSvc.eligibility(workspace, CASE_ID)).reason).to.equal("NOT_UK_CASE");
      caseRow.ukJurisdiction = "Scotland";
      caseRow.lawyerReadiness = { blockedBy: "PERSONAL_INJURY" };
      expect((await ClientRequestSvc.eligibility(workspace, CASE_ID)).reason).to.equal("PERSONAL_INJURY_EXCLUDED");
      caseRow.lawyerReadiness = null;
      paid = false;
      expect((await ClientRequestSvc.eligibility(workspace, CASE_ID)).reason).to.equal("CASE_NOT_PAID");
      paid = true;
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
      expect(dto).to.include({ caseId: CASE_ID, status: "REQUESTED", note: "Prefer a fixed fee.", consentVersion: CLIENT_REQUEST_CONSENT_VERSION, lawyer: null, quote: null });
      expect(new Date(dto.consentAcceptedAt).getTime()).to.be.at.least(before);
    });

    it("needs the consent ticked, and the current version of it", async () => {
      expect(await errorOf(ask({ consentAccepted: false }))).to.deep.equal({ status: 400, code: "CONSENT_REQUIRED" });
      expect(await errorOf(ask({ consentVersion: "2020-01-01" }))).to.deep.equal({ status: 409, code: "CONSENT_VERSION_STALE" });
      expect(requests.size).to.equal(0);
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
  });

  it("validates the note length and the case id", () => {
    const base = { caseId: CASE_ID, consentVersion: "v", consentAccepted: true };
    expect(createClientRequestSchema.validate(base).error).to.equal(undefined);
    expect(createClientRequestSchema.validate({ ...base, note: "x".repeat(1001) }).error).to.not.equal(undefined);
    expect(createClientRequestSchema.validate({ ...base, caseId: "nope" }).error).to.not.equal(undefined);
  });
});
