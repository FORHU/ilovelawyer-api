/** ClientRequestLawyerSvc.intakePackage (ADR 0018): the engaged lawyer's full read of the
 * client's intake, transcript and documents. No live Postgres: repositories are monkeypatched,
 * same idiom as test/client-request-lawyer.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import ClientRequestLawyerSvc, { type LawyerContext } from "../src/services/client-request-lawyer.service";
import ClientRequestRepo from "../src/repositories/client-request.repository";
import ClientIntakeRepo from "../src/repositories/client-intake.repository";
import ChatRepo from "../src/repositories/chat.repository";
import LawyerProfileRepo from "../src/repositories/lawyer-profile.repository";
import SecurityAuditSvc from "../src/services/security-audit.service";

function stash<T extends object>(target: T, keys: (keyof T)[]) {
  const saved = keys.map((k) => [k, target[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

async function errorOf(promise: Promise<unknown>): Promise<{ status?: number; code?: string } | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err: any) {
    return { status: err.statusCode, code: err.code };
  }
}

const me: LawyerContext = { userId: "lawyer-me", organizationId: "org-me", tenantCode: "UK" };
const REQUEST_ID = "req-1";
const CASE_ID = "case-1";

const PROFILE = { userId: "lawyer-me", verificationStatus: "VERIFIED", acceptingRequests: true };

describe("ClientRequestLawyerSvc.intakePackage", () => {
  let restore: (() => void)[];
  let request: any;
  let found: any;
  let intakeStored: any;
  let messages: any[];
  let securityAudits: any[];

  beforeEach(() => {
    restore = [
      stash(ClientRequestRepo, ["findForLawyer", "findForIntakePackage"]),
      stash(ClientIntakeRepo, ["find"]),
      stash(ChatRepo, ["listMessagesByConsultation"]),
      stash(LawyerProfileRepo, ["find", "findLawyerTenant", "countOpenForLawyers"]),
      stash(SecurityAuditSvc, ["record"]),
    ];

    request = {
      id: REQUEST_ID,
      caseId: CASE_ID,
      status: "ENGAGED",
      claims: [{ lawyerId: "lawyer-me", outcome: "ENGAGED" }],
    };
    found = {
      caseId: CASE_ID,
      note: "Please call after 5pm.",
      case: {
        caseName: "Smith v Acme",
        practiceArea: "EMPLOYMENT",
        ukJurisdiction: "England and Wales",
        jurisdiction: "Leeds",
        clientSide: "CLAIMANT",
        parties: [{ name: "Acme Ltd", designation: "Opposing party" }],
        documents: [{ id: "d1", name: "Dismissal letter.pdf", ragStatus: "READY", category: "evidence", file: { s3Key: "k1", fileUrl: null, filename: "Dismissal letter.pdf" } }],
        consultations: [{ id: "cons-1" }],
      },
    };
    intakeStored = { data: { generatedAt: "2026-10-20T00:00:00.000Z", summary: "An employment dismissal.", people: [], timeline: [], facts: [], goals: [], concerns: [], questionsForLawyer: [], deadlines: [], missing: [], conflicts: [], completeness: null } };
    messages = [
      { id: "m1", role: "user", content: "I was dismissed on 3 March.", createdAt: new Date("2026-03-04T09:00:00Z") },
      { id: "m2", role: "assistant", content: "Thanks, can you tell me more?", createdAt: new Date("2026-03-04T09:01:00Z") },
      { id: "m3", role: "system", content: "internal note", createdAt: new Date("2026-03-04T09:02:00Z") },
    ];
    securityAudits = [];

    (ClientRequestRepo as any).findForLawyer = async (id: string) => (id === REQUEST_ID ? request : null);
    (ClientRequestRepo as any).findForIntakePackage = async (id: string) => (id === REQUEST_ID ? found : null);
    (ClientIntakeRepo as any).find = async () => intakeStored;
    (ChatRepo as any).listMessagesByConsultation = async () => messages;
    (LawyerProfileRepo as any).find = async () => PROFILE;
    (LawyerProfileRepo as any).findLawyerTenant = async () => ({ role: "LAWYER", tenantCode: "UK" });
    (LawyerProfileRepo as any).countOpenForLawyers = async () => new Map();
    (SecurityAuditSvc as any).record = async (input: any) => securityAudits.push(input);
  });

  afterEach(() => restore.forEach((r) => r()));

  it("returns the case details, the full intake, the transcript (client/AI only) and the documents with a URL", async () => {
    const pkg = await ClientRequestLawyerSvc.intakePackage(me, REQUEST_ID);

    expect(pkg.requestId).to.equal(REQUEST_ID);
    expect(pkg.caseId).to.equal(CASE_ID);
    expect(pkg.caseDetails).to.deep.equal({
      title: "Smith v Acme",
      practiceArea: "EMPLOYMENT",
      ukJurisdiction: "England and Wales",
      town: "Leeds",
      side: "CLAIMANT",
      otherParties: [{ name: "Acme Ltd", role: "Opposing party" }],
      clientNote: "Please call after 5pm.",
    });
    // The real name, unredacted — unlike the pre-claim brief's AnonymisedIntake.
    expect(pkg.intake.summary).to.equal("An employment dismissal.");

    expect(pkg.transcript).to.have.length(2);
    expect(pkg.transcript[0]).to.deep.equal({ id: "m1", role: "CLIENT", text: "I was dismissed on 3 March.", createdAt: "2026-03-04T09:00:00.000Z" });
    expect(pkg.transcript[1].role).to.equal("AI");

    expect(pkg.documents).to.have.length(1);
    expect(pkg.documents[0]).to.include({ id: "d1", name: "Dismissal letter.pdf", status: "READY", category: "evidence" });
    expect(pkg.documents[0].url).to.be.a("string");
  });

  it("returns an empty, EMPTY-status intake when none has ever run", async () => {
    intakeStored = null;
    const pkg = await ClientRequestLawyerSvc.intakePackage(me, REQUEST_ID);
    expect(pkg.intake.status).to.equal("EMPTY");
    expect(pkg.intake.summary).to.be.null;
  });

  it("audits every read", async () => {
    await ClientRequestLawyerSvc.intakePackage(me, REQUEST_ID);
    expect(securityAudits).to.have.length(1);
    expect(securityAudits[0]).to.deep.include({ action: "client_request.intake_package_viewed", actorId: "lawyer-me", caseId: CASE_ID });
    expect(securityAudits[0].payload).to.deep.include({ requestId: REQUEST_ID });
  });

  it("404s for a lawyer who was never engaged on this request", async () => {
    request.claims = [{ lawyerId: "someone-else", outcome: "ENGAGED" }];
    expect((await errorOf(ClientRequestLawyerSvc.intakePackage(me, REQUEST_ID)))?.status).to.equal(404);
    expect(securityAudits).to.have.length(0);
  });

  it("409s once the engagement has closed", async () => {
    request.status = "CLOSED";
    const err = await errorOf(ClientRequestLawyerSvc.intakePackage(me, REQUEST_ID));
    expect(err?.status).to.equal(409);
    expect(securityAudits).to.have.length(0);
  });

  it("404s for a request that doesn't exist", async () => {
    expect((await errorOf(ClientRequestLawyerSvc.intakePackage(me, "no-such-request")))?.status).to.equal(404);
  });
});
