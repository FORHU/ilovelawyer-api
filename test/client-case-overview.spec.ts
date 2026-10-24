/** ClientCaseOverviewSvc (ilovelawyer-api#571, C1): GET /api/client/cases/:caseId/overview, the
 * Overview tab's one whitelisted read. No live Postgres: repositories are monkeypatched on their
 * CommonJS module objects, same idiom as test/client-case.spec.ts. */
import fs from "fs";
import path from "path";
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import request from "supertest";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import loginToken from "../src/utils/loginToken";
import ClientCaseOverviewSvc from "../src/services/client-case-overview.service";
import ClientCaseSvc, { type ClientWorkspace } from "../src/services/client-case.service";
import ClientCaseRepo from "../src/repositories/client-case.repository";
import ClientOverviewRepo from "../src/repositories/client-overview.repository";
import DocumentRepo from "../src/repositories/document.repository";
import CaseTimelineRepo from "../src/repositories/case-timeline.repository";
import CaseFindingRepo from "../src/repositories/case-finding.repository";
import MissingEvidenceRepo from "../src/repositories/missing-evidence.repository";
import ProceduralDeadlineRepo from "../src/repositories/procedural-deadline.repository";
import CaseChangeSummaryRepo from "../src/repositories/case-change-summary.repository";
import AiGenerationJobRepo from "../src/repositories/ai-generation-job.repository";
import AiGenerationLockSvc from "../src/services/ai-generation-lock.service";
import CaseFindingAiSvc from "../src/services/case-finding-ai.service";

/** Saves `keys` on `target` for afterEach to put back, so no stub leaks into another spec file. */
const stashed: (() => void)[] = [];
function stash<T extends object>(target: T, keys: string[]) {
  const saved = keys.map((k) => [k, (target as any)[k]] as const);
  stashed.push(() => saved.forEach(([k, v]) => ((target as any)[k] = v)));
}

async function errorOf(promise: Promise<unknown>): Promise<{ status?: number } | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err: any) {
    return { status: err.statusCode };
  }
}

/** Every key path in what the API actually sends: `timeline[].sourceDocumentName`, `sections.mayHurt`… */
function keyPaths(value: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, at: string): void => {
    if (Array.isArray(v)) return v.forEach((item) => walk(item, `${at}[]`));
    if (!v || typeof v !== "object") return;
    for (const [k, child] of Object.entries(v)) {
      const p = at ? `${at}.${k}` : k;
      out.add(p);
      walk(child, p);
    }
  };
  walk(JSON.parse(JSON.stringify(value)), "");
  return [...out].sort();
}

/** The whole contract. A field added to or dropped from the response fails here: change it on
 * purpose, together with src/types/client-overview.ts, swagger-client-app.ts and the client's
 * src/lib/types.ts. */
const CONTRACT = [
  "generatedAt",
  "job",
  "job.startedAt",
  "job.panesDone",
  "changedSince",
  "changedSince.added",
  "changedSince.removed",
  "updates",
  "updates.allowed",
  "updates.leftToday",
  "sections",
  "sections.summary",
  "sections.timeline",
  "sections.keyDates",
  "sections.toGather",
  "sections.helps",
  "sections.mayHurt",
  "summary",
  "timeline",
  "timeline[].id",
  "timeline[].date",
  "timeline[].label",
  "timeline[].sourceDocumentId",
  "timeline[].sourceDocumentName",
  "keyDates",
  "keyDates[].id",
  "keyDates[].label",
  "keyDates[].date",
  "keyDates[].status",
  "toGather",
  "toGather[].id",
  "toGather[].title",
  "toGather[].why",
  "helps",
  "helps[].id",
  "helps[].title",
  "helps[].detail",
  "mayHurt",
  "mayHurt[].id",
  "mayHurt[].title",
  "mayHurt[].detail",
].sort();

const workspace: ClientWorkspace = { id: "org-1", role: "OWNER", tenantCode: "UK" };
const CASE_ID = "case-1";
const GENERATED_AT = new Date("2026-10-20T10:00:00Z");

let caseRow: any;
let stored: any;
let job: any;
let docs: any[];
let lastChange: any;
let deadlineReads: number;

describe("ClientCaseOverviewSvc", () => {
  beforeEach(() => {
    stash(ClientCaseRepo, ["findById"]);
    stash(ClientOverviewRepo, ["find"]);
    stash(AiGenerationJobRepo, ["findBySubjectAndKind"]);
    stash(DocumentRepo, ["listAllByCase"]);
    stash(CaseTimelineRepo, ["list"]);
    stash(CaseFindingRepo, ["list"]);
    stash(MissingEvidenceRepo, ["list"]);
    stash(ProceduralDeadlineRepo, ["list"]);
    stash(CaseChangeSummaryRepo, ["latestRefresh"]);

    // Every list non-empty, a live job and a changed document set, so every field is present.
    caseRow = {
      id: CASE_ID,
      ukJurisdiction: "ENGLAND_AND_WALES",
      documents: [
        { id: "d1", name: "Dismissal letter.pdf", ragStatus: "READY" },
        { id: "d2", name: "Contract.pdf", ragStatus: "READY" },
      ],
    };
    stored = {
      generatedAt: GENERATED_AT,
      readySetFingerprint: "fingerprint-of-d1-only",
      documentIds: ["d1"],
      summary: "Your documents establish 2 events so far.",
      panes: { strategy: "DONE", findings: "DONE", missingEvidence: "DONE" },
      runDay: null,
      runsOnDay: 0,
    };
    job = { status: "IN_PROGRESS", startedAt: new Date(), heartbeatAt: new Date(), stage: "strategy" };
    docs = [
      { id: "d1", ragStatus: "READY", status: "ACTIVE" },
      { id: "d2", ragStatus: "READY", status: "ACTIVE" },
    ];
    lastChange = null;
    deadlineReads = 0;

    (ClientCaseRepo as any).findById = async (id: string, orgId: string) => (id === CASE_ID && orgId === workspace.id ? caseRow : null);
    (ClientOverviewRepo as any).find = async () => stored;
    (AiGenerationJobRepo as any).findBySubjectAndKind = async () => job;
    (DocumentRepo as any).listAllByCase = async () => docs;
    (CaseTimelineRepo as any).list = async () => [
      { id: "t1", occurredOn: new Date("2026-03-01T00:00:00Z"), title: "You were dismissed", documentId: "d1", source: "AI", status: "key_date" },
      { id: "t2", occurredOn: null, title: "A meeting about it", documentId: "deleted-doc", source: "AI", status: "key_date" },
    ];
    (CaseFindingRepo as any).list = async () => [
      { id: "f1", category: "STRENGTH", label: "You were never warned", detail: "No warning letters exist.", sourceLabel: "the letter", position: 0 },
      { id: "f2", category: "WEAKNESS", label: "You signed the policy", detail: null, sourceLabel: null, position: 1 },
      { id: "f3", category: "ATTACK_STRATEGY", label: "Lawyer-only", detail: "Lawyer-only", sourceLabel: null, position: 2 },
    ];
    (MissingEvidenceRepo as any).list = async () => [
      { id: "m1", status: "OPEN", label: "Your payslips", detail: "They show what you earned." },
      { id: "m2", status: "RESOLVED", label: "Resolved by a lawyer", detail: null },
    ];
    (ProceduralDeadlineRepo as any).list = async () => {
      deadlineReads++;
      return [
        { id: "k1", label: "Tribunal claim deadline", computedDueDate: new Date("2026-05-31T00:00:00Z"), confirmations: [{ confirmed: true }] },
        { id: "k2", label: "Early conciliation", computedDueDate: new Date("2026-04-30T00:00:00Z"), confirmations: [{ confirmed: false }] },
      ];
    };
    (CaseChangeSummaryRepo as any).latestRefresh = async () => lastChange;
  });
  afterEach(() => {
    while (stashed.length) stashed.pop()!();
  });

  describe("contract", () => {
    it("returns exactly the listed fields", async () => {
      expect(keyPaths(await ClientCaseOverviewSvc.get(workspace, CASE_ID))).to.deep.equal(CONTRACT);
    });

    it("leaves out keyDates entirely for a case outside the UK (D5), without reading deadlines", async () => {
      caseRow.ukJurisdiction = null;
      const dto = await ClientCaseOverviewSvc.get(workspace, CASE_ID);
      expect(keyPaths(dto)).to.deep.equal(CONTRACT.filter((p) => !p.startsWith("keyDates") && p !== "sections.keyDates"));
      expect(deadlineReads).to.equal(0);
    });

    it("keeps keyDates for Scotland and Northern Ireland — they're still in the UK", async () => {
      caseRow.ukJurisdiction = "SCOTLAND";
      expect((await ClientCaseOverviewSvc.get(workspace, CASE_ID)).keyDates).to.have.length(2);
    });
  });

  describe("ownership", () => {
    it("404s for another client's case", async () => {
      expect((await errorOf(ClientCaseOverviewSvc.get({ ...workspace, id: "org-2" }, CASE_ID)))?.status).to.equal(404);
    });
  });

  describe("the route", () => {
    let role: string;
    const route = (as: string) => request(app).get(`/api/client/cases/${CASE_ID}/overview`).set({ Authorization: `Bearer ${loginToken(as).accessToken}` });

    beforeEach(() => {
      stash(prisma.user as any, ["findUnique"]);
      stash(ClientCaseSvc, ["workspaceFor"]);
      role = "USER";
      (prisma.user as any).findUnique = async () => ({ role, name: "Sam Client", username: "sam.1234" });
      (ClientCaseSvc as any).workspaceFor = async (userId: string) => ({ ...workspace, id: userId === "other-client" ? "org-2" : workspace.id });
    });

    it("serves the client's own case", async () => {
      const res = await route("client");
      expect(res.status).to.equal(200);
      expect(keyPaths(res.body)).to.deep.equal(CONTRACT);
    });

    it("refuses a lawyer with 403 CLIENT_ACCOUNT_ONLY", async () => {
      role = "LAWYER";
      const res = await route("lawyer");
      expect(res.status).to.equal(403);
      expect(res.body.code).to.equal("CLIENT_ACCOUNT_ONLY");
    });

    it("404s for another client", async () => {
      expect((await route("other-client")).status).to.equal(404);
    });
  });

  describe("no side effects", () => {
    it("imports nothing that writes, queues, takes a lock or runs AI", () => {
      const source = fs.readFileSync(path.join(__dirname, "../src/services/client-case-overview.service.ts"), "utf8");
      const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      const forbidden = /case-snapshot|queues\/|ai-generation-lock\.service|-ai\.service|case-refresh|case-change-run|client-overview\.service/;
      expect(imports.filter((i) => forbidden.test(i))).to.deep.equal([]);
    });

    it("reads without calling any write, even with every one of them set to throw", async () => {
      const boom = async () => {
        throw new Error("a GET must not write");
      };
      const writes: [object, string[]][] = [
        [ClientOverviewRepo, ["saveResult", "claimDailyRun"]],
        [AiGenerationLockSvc, ["begin", "finishWith", "setStage"]],
        [AiGenerationJobRepo, ["create", "markInProgress", "updateStatus", "updateStage", "touchHeartbeat"]],
        [CaseChangeSummaryRepo, ["create"]],
        [CaseFindingAiSvc, ["scheduleIfOutdated"]],
      ];
      for (const [target, keys] of writes) {
        stash(target, keys);
        for (const k of keys) (target as any)[k] = boom;
      }
      await ClientCaseOverviewSvc.get(workspace, CASE_ID);
    });
  });

  describe("mapping", () => {
    it("marks a deadline CONFIRMED once anyone has confirmed it, ESTIMATED otherwise", async () => {
      const dto = await ClientCaseOverviewSvc.get(workspace, CASE_ID);
      expect(dto.keyDates).to.deep.equal([
        { id: "k1", label: "Tribunal claim deadline", date: "2026-05-31T00:00:00.000Z", status: "CONFIRMED" },
        { id: "k2", label: "Early conciliation", date: "2026-04-30T00:00:00.000Z", status: "ESTIMATED" },
      ]);
      expect(dto.sections.keyDates).to.equal("READY");
    });

    it("is EMPTY for key dates when the case has no deadlines", async () => {
      (ProceduralDeadlineRepo as any).list = async () => [];
      expect((await ClientCaseOverviewSvc.get(workspace, CASE_ID)).sections.keyDates).to.equal("EMPTY");
    });

    it("names a timeline entry's document, and drops the link once that document is gone", async () => {
      const dto = await ClientCaseOverviewSvc.get(workspace, CASE_ID);
      expect(dto.timeline).to.deep.equal([
        { id: "t1", date: "2026-03-01T00:00:00.000Z", label: "You were dismissed", sourceDocumentId: "d1", sourceDocumentName: "Dismissal letter.pdf" },
        { id: "t2", date: null, label: "A meeting about it", sourceDocumentId: null, sourceDocumentName: null },
      ]);
    });

    it("shows strengths and weaknesses only, and open items to gather only", async () => {
      const dto = await ClientCaseOverviewSvc.get(workspace, CASE_ID);
      expect(dto.helps).to.deep.equal([{ id: "f1", title: "You were never warned", detail: "No warning letters exist." }]);
      expect(dto.mayHurt).to.deep.equal([{ id: "f2", title: "You signed the policy", detail: null }]);
      expect(dto.toGather).to.deep.equal([{ id: "m1", title: "Your payslips", why: "They show what you earned." }]);
    });
  });

  describe("status", () => {
    it("reports a live job's finished panes, with fresh content for those and RUNNING for the rest", async () => {
      const dto = await ClientCaseOverviewSvc.get(workspace, CASE_ID);
      expect(dto.job?.panesDone).to.deep.equal(["strategy"]);
      expect(dto.updates.allowed).to.equal(false);
      expect(dto.sections).to.deep.include({ summary: "READY", timeline: "READY", helps: "RUNNING", mayHurt: "RUNNING", toGather: "RUNNING" });
    });

    it("goes STALE on every job-written section once the documents changed, and counts the change", async () => {
      job = { status: "DONE", startedAt: GENERATED_AT, heartbeatAt: GENERATED_AT };
      const dto = await ClientCaseOverviewSvc.get(workspace, CASE_ID);
      expect(dto.job).to.equal(null);
      expect(dto.sections).to.deep.equal({ summary: "STALE", timeline: "STALE", keyDates: "READY", toGather: "STALE", helps: "STALE", mayHurt: "STALE" });
      expect(dto.changedSince).to.deep.equal({ added: 1, removed: 0 });
    });

    it("counts the change against the last run's change summary when it saved", async () => {
      job = null;
      // Neither d1 nor d2: shows the summary, not the stored ids, is what's compared.
      lastChange = { createdAt: new Date(GENERATED_AT.getTime() + 1000), readyDocumentIds: ["d0"] };
      expect((await ClientCaseOverviewSvc.get(workspace, CASE_ID)).changedSince).to.deep.equal({ added: 2, removed: 1 });
    });

    it("ignores a change summary older than the last run — its own save must have failed", async () => {
      job = null;
      lastChange = { createdAt: new Date(GENERATED_AT.getTime() - 1000), readyDocumentIds: ["d0"] };
      expect((await ClientCaseOverviewSvc.get(workspace, CASE_ID)).changedSince).to.deep.equal({ added: 1, removed: 0 });
    });

    it("is FAILED, not EMPTY, when the first run failed or was lost before saving anything", async () => {
      stored = null;
      job = { status: "FAILED", startedAt: GENERATED_AT, heartbeatAt: GENERATED_AT };
      expect((await ClientCaseOverviewSvc.get(workspace, CASE_ID)).sections.helps).to.equal("FAILED");
      job = { status: "IN_PROGRESS", startedAt: GENERATED_AT, heartbeatAt: GENERATED_AT };
      expect((await ClientCaseOverviewSvc.get(workspace, CASE_ID)).sections.helps).to.equal("FAILED");
    });

    it("is EMPTY everywhere with no changedSince before anything has run", async () => {
      stored = null;
      job = null;
      const dto = await ClientCaseOverviewSvc.get(workspace, CASE_ID);
      expect(dto.generatedAt).to.equal(null);
      expect(dto.changedSince).to.equal(null);
      expect(dto.sections).to.deep.include({ summary: "EMPTY", timeline: "EMPTY", toGather: "EMPTY", helps: "EMPTY", mayHurt: "EMPTY" });
    });
  });
});
