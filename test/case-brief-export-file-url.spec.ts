/** CaseBriefExportSvc's download links — the `/files/<token>` URL has to carry the brief's
 * filename, or the browser saves it under the JWT itself with no extension (the #458 bug). No live
 * S3/Postgres/renderers: everything is monkeypatched on its CommonJS module object, same idiom as
 * test/generated-document-export-service.spec.ts.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import CaseBriefExportSvc from "../src/services/case-brief-export.service";
import CaseSnapshotSvc from "../src/services/case-snapshot.service";
import CaseBriefExportRepo from "../src/repositories/case-brief-export.repository";
import FilesRepo from "../src/repositories/files.repository";
import CaseAccess from "../src/utils/case-access";
import SecurityAuditSvc from "../src/services/security-audit.service";
import * as s3 from "../src/utils/s3";
import * as briefDocument from "../src/utils/case-brief-document";
import * as docxRenderer from "../src/utils/case-brief-docx-renderer";
import * as pdfRenderer from "../src/utils/case-brief-pdf-renderer";

describe("CaseBriefExportSvc file URLs", () => {
  const originals = {
    snapshotGet: CaseSnapshotSvc.get,
    repoCreate: CaseBriefExportRepo.create,
    repoList: CaseBriefExportRepo.listByCase,
    filesCreate: FilesRepo.create,
    loadAccessibleCase: CaseAccess.loadAccessibleCase,
    uploadToS3: s3.uploadToS3,
    getProxyFileUrl: s3.getProxyFileUrl,
    record: SecurityAuditSvc.record,
    buildBriefDocument: briefDocument.buildBriefDocument,
    renderDocx: docxRenderer.renderBriefToDocx,
    renderPdf: pdfRenderer.renderBriefToPdf,
  };

  let proxyCalls: { key: string; opts: unknown }[];
  let audits: unknown[];

  beforeEach(() => {
    proxyCalls = [];
    audits = [];
    (CaseSnapshotSvc as any).get = async () => ({ case: { caseName: "Grant v. Blackwood" } });
    (CaseBriefExportRepo as any).create = async () => ({ id: "export-1" });
    (SecurityAuditSvc as any).record = async (data: unknown) => void audits.push(data);
    (FilesRepo as any).create = async (filename: string, fileUrl: string, s3Key: string) => ({
      id: "file-1",
      filename,
      fileUrl,
      s3Key,
    });
    (CaseAccess as any).loadAccessibleCase = async () => ({});
    (s3 as any).uploadToS3 = async (key: string) => `https://s3.example/${key}`;
    (s3 as any).getProxyFileUrl = (key: string, opts: unknown) => {
      proxyCalls.push({ key, opts });
      return `/files/token-for-${key}`;
    };
    (briefDocument as any).buildBriefDocument = () => ({});
    (docxRenderer as any).renderBriefToDocx = async () => Buffer.from("docx");
    (pdfRenderer as any).renderBriefToPdf = async () => Buffer.from("pdf");
  });

  afterEach(() => {
    (CaseSnapshotSvc as any).get = originals.snapshotGet;
    (CaseBriefExportRepo as any).create = originals.repoCreate;
    (CaseBriefExportRepo as any).listByCase = originals.repoList;
    (FilesRepo as any).create = originals.filesCreate;
    (CaseAccess as any).loadAccessibleCase = originals.loadAccessibleCase;
    (s3 as any).uploadToS3 = originals.uploadToS3;
    (s3 as any).getProxyFileUrl = originals.getProxyFileUrl;
    (SecurityAuditSvc as any).record = originals.record;
    (briefDocument as any).buildBriefDocument = originals.buildBriefDocument;
    (docxRenderer as any).renderBriefToDocx = originals.renderDocx;
    (pdfRenderer as any).renderBriefToPdf = originals.renderPdf;
  });

  it("export() signs the link with the brief's filename, inline so the preview iframe renders it", async () => {
    await CaseBriefExportSvc.export("case-1", "user-1", "docx");
    expect(proxyCalls).to.have.length(1);
    expect(proxyCalls[0]!.opts).to.deep.equal({
      filename: "Grant-v-Blackwood-case-brief.docx",
      disposition: "inline",
      audit: { kind: "case_brief", id: "export-1", caseId: "case-1" },
    });
  });

  it("export() records the export in the security audit log, without the case name", async () => {
    await CaseBriefExportSvc.export("case-1", "user-1", "pdf");
    expect(audits).to.deep.equal([
      {
        action: "export.case_brief",
        actorId: "user-1",
        targetType: "file",
        targetId: "file-1",
        caseId: "case-1",
        payload: { format: "pdf", exportId: "export-1" },
      },
    ]);
  });

  it("listHistory() signs each entry with its stored filename", async () => {
    (CaseBriefExportRepo as any).listByCase = async () => [
      {
        id: "e1",
        format: "pdf",
        createdAt: new Date("2026-09-28"),
        file: { id: "f1", s3Key: "case-briefs/case-1/1.pdf", filename: "Grant-v-Blackwood-case-brief.pdf" },
      },
    ];
    await CaseBriefExportSvc.listHistory("case-1", "user-1");
    expect(proxyCalls).to.deep.equal([
      {
        key: "case-briefs/case-1/1.pdf",
        opts: {
          filename: "Grant-v-Blackwood-case-brief.pdf",
          disposition: "inline",
          audit: { kind: "case_brief", id: "e1", caseId: "case-1" },
        },
      },
    ]);
  });
});
