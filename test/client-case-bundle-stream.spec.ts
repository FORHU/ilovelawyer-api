/** ClientCaseSummarySvc.streamZip — the "Download case files" ZIP (case-summary.pdf plus every
 * uploaded document). No live Postgres/S3: ClientCaseSvc.get, ClientIntakeSvc.get and
 * DocumentRepo.listByCase are monkeypatched on their module objects, same idiom as
 * test/client-case.spec.ts; the file storage is a fake ExportFileSource. */
import { expect } from "chai";
import { describe, it, afterEach } from "mocha";
import { Readable } from "stream";
import JSZip from "jszip";
import ClientCaseSummarySvc from "../src/services/client-case-summary.service";
import ClientCaseSvc, { type ClientWorkspace } from "../src/services/client-case.service";
import ClientIntakeSvc from "../src/services/client-intake.service";
import DocumentRepo from "../src/repositories/document.repository";
import SecurityAuditSvc from "../src/services/security-audit.service";
import type { CaseIntake } from "../src/types/client-intake";
import type { ExportFileSource } from "../src/services/data-export.service";

function stash<T extends object>(target: T, keys: string[]) {
  const saved = keys.map((k) => [k, (target as any)[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

async function errorOf(promise: Promise<unknown>): Promise<{ status?: number; code?: string; message?: string } | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err: any) {
    return { status: err.statusCode, code: err.code, message: err.message };
  }
}

const workspace: ClientWorkspace = { id: "org-personal", role: "OWNER", tenantCode: "UK" };

function fakeCase(overrides: Record<string, unknown> = {}) {
  return {
    title: "Landlord won't return my deposit",
    areas: [],
    ukJurisdiction: "England and Wales",
    outsideUk: false,
    where: "Leeds",
    notes: "",
    documents: [],
    ...overrides,
  };
}

function fakeIntake(overrides: Partial<CaseIntake> = {}): CaseIntake {
  return {
    generatedAt: "2026-11-18T09:30:00.000Z",
    status: "READY",
    updates: { allowed: true, leftToday: 3 },
    summary: "AI SUMMARY PARAGRAPH",
    people: [],
    timeline: [],
    facts: [],
    goals: [],
    concerns: [],
    missing: [],
    deadlines: [],
    questionsForLawyer: [],
    conflicts: [],
    ...overrides,
  } as CaseIntake;
}

describe("ClientCaseSummarySvc.streamZip", () => {
  let restore: () => void;

  afterEach(() => restore?.());

  it("bundles the case summary PDF and every uploaded document, skipping one that can't be read", async () => {
    restore = stash(ClientCaseSvc, ["get"]);
    const restoreIntake = stash(ClientIntakeSvc, ["get"]);
    const restoreDocs = stash(DocumentRepo, ["listByCase"]);
    const restoreAudit = stash(SecurityAuditSvc, ["record"]);

    (ClientCaseSvc as any).get = async () => fakeCase();
    (ClientIntakeSvc as any).get = async () => fakeIntake();
    (DocumentRepo as any).listByCase = async () => [
      { id: "doc-good-1", name: "tenancy.pdf", file: { s3Key: "good-key", filename: "tenancy.pdf" } },
      { id: "doc-bad-1", name: "missing.pdf", file: { s3Key: "missing-key", filename: "missing.pdf" } },
    ];
    (SecurityAuditSvc as any).record = async () => undefined;

    const fakeFiles: ExportFileSource = {
      open: async (key: string) => {
        if (key === "missing-key") throw new Error("NoSuchKey");
        return { body: Readable.from([Buffer.from("file bytes")]) };
      },
    };

    const chunks: Buffer[] = [];
    const result = await ClientCaseSummarySvc.streamZip(workspace, "user-1", "case-1", "en", (c) => {
      chunks.push(c);
    }, fakeFiles);

    const zip = await JSZip.loadAsync(Buffer.concat(chunks));
    expect(Object.keys(zip.files)).to.include("case-summary.pdf");
    expect(Object.keys(zip.files).some((name) => name.endsWith("-tenancy.pdf"))).to.equal(true);
    expect(result.filesIncluded).to.equal(1);
    expect(result.filesSkipped).to.equal(1);
    expect(result.filename).to.match(/^case-export-landlord-won-t-return-my-deposit-\d{4}-\d{2}-\d{2}\.zip$/);

    restoreIntake();
    restoreDocs();
    restoreAudit();
  });

  it("throws INTAKE_RUNNING while a refresh is in flight", async () => {
    restore = stash(ClientCaseSvc, ["get"]);
    const restoreIntake = stash(ClientIntakeSvc, ["get"]);
    (ClientCaseSvc as any).get = async () => fakeCase();
    (ClientIntakeSvc as any).get = async () => fakeIntake({ status: "RUNNING" });

    const err = await errorOf(ClientCaseSummarySvc.streamZip(workspace, "user-1", "case-1", "en", () => undefined));
    expect(err?.code).to.equal("INTAKE_RUNNING");

    restoreIntake();
  });

  it("throws INTAKE_EMPTY when nothing has been generated yet", async () => {
    restore = stash(ClientCaseSvc, ["get"]);
    const restoreIntake = stash(ClientIntakeSvc, ["get"]);
    (ClientCaseSvc as any).get = async () => fakeCase();
    (ClientIntakeSvc as any).get = async () => fakeIntake({ generatedAt: null, status: "EMPTY" });

    const err = await errorOf(ClientCaseSummarySvc.streamZip(workspace, "user-1", "case-1", "en", () => undefined));
    expect(err?.code).to.equal("INTAKE_EMPTY");

    restoreIntake();
  });

  it("succeeds with just case-summary.pdf when the case has no uploaded documents", async () => {
    restore = stash(ClientCaseSvc, ["get"]);
    const restoreIntake = stash(ClientIntakeSvc, ["get"]);
    const restoreDocs = stash(DocumentRepo, ["listByCase"]);
    const restoreAudit = stash(SecurityAuditSvc, ["record"]);

    (ClientCaseSvc as any).get = async () => fakeCase();
    (ClientIntakeSvc as any).get = async () => fakeIntake();
    (DocumentRepo as any).listByCase = async () => [];
    (SecurityAuditSvc as any).record = async () => undefined;

    const chunks: Buffer[] = [];
    const result = await ClientCaseSummarySvc.streamZip(workspace, "user-1", "case-1", "en", (c) => {
      chunks.push(c);
    });

    const zip = await JSZip.loadAsync(Buffer.concat(chunks));
    expect(Object.keys(zip.files)).to.deep.equal(["case-summary.pdf"]);
    expect(result.filesIncluded).to.equal(0);
    expect(result.filesSkipped).to.equal(0);

    restoreIntake();
    restoreDocs();
    restoreAudit();
  });
});
