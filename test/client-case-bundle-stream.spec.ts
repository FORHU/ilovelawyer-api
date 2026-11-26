/** ClientCaseSummarySvc.streamZip — the "Download case files" ZIP (case-summary.pdf plus every
 * uploaded document). No live Postgres/S3: ClientCaseSvc.get, ClientIntakeSvc.get and
 * DocumentRepo.listByCase are monkeypatched on their module objects, same idiom as
 * test/client-case.spec.ts; the file storage is a fake ExportFileSource. */
import { expect } from "chai";
import { describe, it, afterEach, beforeEach } from "mocha";
import { Readable } from "stream";
import JSZip from "jszip";
import request from "supertest";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import loginToken from "../src/utils/loginToken";
import ClientCaseSummarySvc from "../src/services/client-case-summary.service";
import ClientCaseSvc, { type ClientWorkspace } from "../src/services/client-case.service";
import ClientIntakeSvc from "../src/services/client-intake.service";
import DocumentRepo from "../src/repositories/document.repository";
import SecurityAuditSvc from "../src/services/security-audit.service";
import type { CaseIntake } from "../src/types/client-intake";
import type { ExportFileSource } from "../src/services/data-export.service";
import HttpError from "../src/utils/http-error";

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
    let filenameAtFirstChunk: string | null = null;
    let filenameSeen: string | null = null;
    const result = await ClientCaseSummarySvc.streamZip(
      workspace,
      "user-1",
      "case-1",
      "en",
      (c) => {
        if (chunks.length === 0) filenameAtFirstChunk = filenameSeen;
        chunks.push(c);
      },
      fakeFiles,
      (filename) => (filenameSeen = filename),
    );

    const zip = await JSZip.loadAsync(Buffer.concat(chunks));
    expect(Object.keys(zip.files)).to.include("case-summary.pdf");
    expect(Object.keys(zip.files).some((name) => name.endsWith("-tenancy.pdf"))).to.equal(true);
    expect(result.filesIncluded).to.equal(1);
    expect(result.filesSkipped).to.equal(1);
    expect(result.filename).to.match(/^case-export-landlord-won-t-return-my-deposit-\d{4}-\d{2}-\d{2}\.zip$/);
    // onFilename must fire before the first byte reaches the sink, so a caller can still set
    // Content-Disposition on the response at that point.
    expect(filenameAtFirstChunk).to.equal(result.filename);

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

const binaryParser = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

describe("GET /api/client/cases/:caseId/export?format=zip", () => {
  const stashed: (() => void)[] = [];
  const stashHttp = <T extends object>(target: T, keys: string[]) => stashed.push(stash(target, keys));

  beforeEach(() => {
    stashHttp(prisma.user as any, ["findUnique"]);
    stashHttp(ClientCaseSvc, ["workspaceFor"]);
    stashHttp(ClientCaseSummarySvc, ["streamZip"]);
    (prisma.user as any).findUnique = async () => ({ role: "USER", name: "Sam Client", username: "sam.1234" });
    (ClientCaseSvc as any).workspaceFor = async () => ({ id: "org-personal", role: "OWNER", tenantCode: "UK" });
  });

  afterEach(() => {
    while (stashed.length) stashed.pop()!();
  });

  const get = () => request(app).get("/api/client/cases/case-1/export?format=zip").set({ Authorization: `Bearer ${loginToken("client-1").accessToken}` }).buffer(true).parse(binaryParser);

  it("streams a ZIP with the filename set before the body", async () => {
    (ClientCaseSummarySvc as any).streamZip = async (
      _workspace: unknown,
      _userId: string,
      _caseId: string,
      _lang: string,
      sink: (chunk: Buffer) => void,
      _files?: unknown,
      onFilename?: (filename: string) => void,
    ) => {
      onFilename?.("case-export-fired-by-my-boss-2026-11-26.zip");
      sink(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      return { filename: "case-export-fired-by-my-boss-2026-11-26.zip", filesIncluded: 1, filesSkipped: 0 };
    };

    const res = await get();
    expect(res.status).to.equal(200);
    expect(res.headers["content-type"]).to.include("application/zip");
    expect(res.headers["content-disposition"]).to.include("case-export-fired-by-my-boss-2026-11-26.zip");
    expect((res.body as Buffer).subarray(0, 4)).to.deep.equal(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  });

  it("surfaces INTAKE_EMPTY the same way the pdf export does", async () => {
    (ClientCaseSummarySvc as any).streamZip = async () => {
      throw new HttpError("There's nothing to put in a case summary yet. Tell us about your case in the chat first.", 409, "INTAKE_EMPTY");
    };

    const res = await get();
    expect(res.status).to.equal(409);
    expect((res.body as any).code ?? JSON.parse((res.body as Buffer).toString()).code).to.equal("INTAKE_EMPTY");
  });
});
