/** GeneratedDocumentExportSvc — #89, wraps chat-wonder's drafted text (draft_pleading /
 * generate_legal_document output) into a downloadable docx/pdf via the same rendering pipeline
 * as CaseBriefExportSvc. No live S3/Postgres/renderers: FilesRepo, the s3 utils, and the two
 * renderers are monkeypatched on their CommonJS module objects, same idiom as
 * test/decision-record-service.spec.ts.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import GeneratedDocumentExportSvc from "../src/services/generated-document-export.service";
import FilesRepo from "../src/repositories/files.repository";
import * as s3 from "../src/utils/s3";
import * as docxRenderer from "../src/utils/case-brief-docx-renderer";
import * as pdfRenderer from "../src/utils/case-brief-pdf-renderer";
import type { BriefDocument } from "../src/utils/case-brief-document";

describe("GeneratedDocumentExportSvc.export", () => {
  const originals = {
    filesCreate: FilesRepo.create,
    uploadToS3: s3.uploadToS3,
    getPresignedGetUrl: s3.getPresignedGetUrl,
    renderDocx: docxRenderer.renderBriefToDocx,
    renderPdf: pdfRenderer.renderBriefToPdf,
  };

  let filesCreateCalls: any[];
  let uploadCalls: { key: string; body: Buffer; contentType: string }[];
  let renderedDocs: { renderer: "docx" | "pdf"; doc: BriefDocument }[];

  beforeEach(() => {
    filesCreateCalls = [];
    uploadCalls = [];
    renderedDocs = [];

    (FilesRepo as any).create = async (filename: string, fileUrl: string, s3Key: string, metaData?: unknown) => {
      const row = { id: "file-1", filename, fileUrl, s3Key, metaData };
      filesCreateCalls.push(row);
      return row;
    };
    (s3 as any).uploadToS3 = async (key: string, body: Buffer, contentType: string) => {
      uploadCalls.push({ key, body, contentType });
      return `https://s3.example/${key}`;
    };
    (s3 as any).getPresignedGetUrl = async (key: string) => `https://s3.example/presigned/${key}`;
    (docxRenderer as any).renderBriefToDocx = async (doc: BriefDocument) => {
      renderedDocs.push({ renderer: "docx", doc });
      return Buffer.from("fake-docx-bytes");
    };
    (pdfRenderer as any).renderBriefToPdf = async (doc: BriefDocument) => {
      renderedDocs.push({ renderer: "pdf", doc });
      return Buffer.from("fake-pdf-bytes");
    };
  });

  afterEach(() => {
    (FilesRepo as any).create = originals.filesCreate;
    (s3 as any).uploadToS3 = originals.uploadToS3;
    (s3 as any).getPresignedGetUrl = originals.getPresignedGetUrl;
    (docxRenderer as any).renderBriefToDocx = originals.renderDocx;
    (pdfRenderer as any).renderBriefToPdf = originals.renderPdf;
  });

  it("renders docx, uploads it, and records the file with chat-wonder metadata", async () => {
    const result = await GeneratedDocumentExportSvc.export(
      "1. First paragraph.\n\n2. Second paragraph.",
      "Opposition to Motion for Reconsideration",
      "docx",
    );

    expect(renderedDocs).to.have.length(1);
    expect(renderedDocs[0]!.renderer).to.equal("docx");
    expect(uploadCalls).to.have.length(1);
    expect(uploadCalls[0]!.key).to.match(/^generated-documents\/[0-9a-f-]{36}\.docx$/);
    expect(uploadCalls[0]!.contentType).to.equal(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );

    expect(filesCreateCalls).to.have.length(1);
    expect(filesCreateCalls[0]!.filename).to.equal("Opposition-to-Motion-for-Reconsideration.docx");
    expect(filesCreateCalls[0]!.metaData).to.deep.equal({
      source: "chat-wonder",
      documentName: "Opposition to Motion for Reconsideration",
    });

    expect(result).to.deep.equal({
      file: {
        id: "file-1",
        fileUrl: `https://s3.example/presigned/${uploadCalls[0]!.key}`,
        filename: "Opposition-to-Motion-for-Reconsideration.docx",
      },
    });
  });

  it("renders pdf instead of docx when format is pdf", async () => {
    await GeneratedDocumentExportSvc.export("Some content.", "Demand Letter", "pdf");
    expect(renderedDocs).to.have.length(1);
    expect(renderedDocs[0]!.renderer).to.equal("pdf");
    expect(uploadCalls[0]!.key).to.match(/\.pdf$/);
    expect(uploadCalls[0]!.contentType).to.equal("application/pdf");
  });

  it("wraps the document in exactly one section titled with documentName", async () => {
    await GeneratedDocumentExportSvc.export("Body text.", "My Document", "docx");
    const doc = renderedDocs[0]!.doc;
    expect(doc.cover.caseName).to.equal("My Document");
    expect(doc.sections).to.have.length(1);
    expect(doc.sections[0]!.title).to.equal("My Document");
  });

  it("splits blank-line-separated text into paragraph blocks", async () => {
    await GeneratedDocumentExportSvc.export(
      "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.",
      "Doc",
      "docx",
    );
    const blocks = renderedDocs[0]!.doc.sections[0]!.blocks;
    expect(blocks).to.deep.equal([
      { type: "paragraph", text: "First paragraph." },
      { type: "paragraph", text: "Second paragraph." },
      { type: "paragraph", text: "Third paragraph." },
    ]);
  });

  it("promotes literal markdown # / ## lines to heading1/heading2, leaves everything else as paragraphs", async () => {
    await GeneratedDocumentExportSvc.export(
      "# Main Title\n\nSome intro text.\n\n## Subsection\n\nOPPOSITION TO MOTION FOR RECONSIDERATION\n\nBody paragraph.",
      "Doc",
      "docx",
    );
    const blocks = renderedDocs[0]!.doc.sections[0]!.blocks;
    expect(blocks).to.deep.equal([
      { type: "heading1", text: "Main Title" },
      { type: "paragraph", text: "Some intro text." },
      { type: "heading2", text: "Subsection" },
      // All-caps title-like lines are deliberately NOT promoted to headings — see the
      // function's own comment: no `#`/`##` syntax in real chat-wonder output, and detecting
      // all-caps would misfire on mid-document lines like "WHEREFORE, premises considered...".
      { type: "paragraph", text: "OPPOSITION TO MOTION FOR RECONSIDERATION" },
      { type: "paragraph", text: "Body paragraph." },
    ]);
  });

  it("sanitizes a documentName with special characters into a safe filename", async () => {
    await GeneratedDocumentExportSvc.export("Body.", "Dela Cruz v. Santos: Opp'n (Rev. 2)", "pdf");
    expect(filesCreateCalls[0]!.filename).to.match(/^[a-zA-Z0-9-_]+\.pdf$/);
  });
});
