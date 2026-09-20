/** GeneratedDocumentExportSvc — renders chat-wonder's drafted text (draft_pleading /
 * generate_legal_document output) to a docx/pdf, uploads it and records the file. No live
 * S3/Postgres/renderers: FilesRepo, the s3 util and the two renderers are monkeypatched on their
 * CommonJS module objects, same idiom as test/decision-record-service.spec.ts.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import GeneratedDocumentExportSvc from "../src/services/generated-document-export.service";
import FilesRepo from "../src/repositories/files.repository";
import * as s3 from "../src/utils/s3";
import * as renderer from "../src/utils/generated-document-renderer";

describe("GeneratedDocumentExportSvc.export", () => {
  const originals = {
    filesCreate: FilesRepo.create,
    uploadToS3: s3.uploadToS3,
    getPresignedGetUrl: s3.getPresignedGetUrl,
    renderDocx: renderer.renderGeneratedDocx,
    renderPdf: renderer.renderGeneratedPdf,
  };

  let filesCreateCalls: any[];
  let uploadCalls: { key: string; body: Buffer; contentType: string }[];
  let rendered: { renderer: "docx" | "pdf"; content: string }[];

  beforeEach(() => {
    filesCreateCalls = [];
    uploadCalls = [];
    rendered = [];

    (FilesRepo as any).create = async (filename: string, fileUrl: string, s3Key: string, metaData?: unknown) => {
      const row = { id: "file-1", filename, fileUrl, s3Key, metaData };
      filesCreateCalls.push(row);
      return row;
    };
    (s3 as any).getPresignedGetUrl = async (key: string) => `https://s3.example/presigned/${key}`;
    (s3 as any).uploadToS3 = async (key: string, body: Buffer, contentType: string) => {
      uploadCalls.push({ key, body, contentType });
      return `https://s3.example/${key}`;
    };
    (renderer as any).renderGeneratedDocx = async (content: string) => {
      rendered.push({ renderer: "docx", content });
      return Buffer.from("fake-docx-bytes");
    };
    (renderer as any).renderGeneratedPdf = async (content: string) => {
      rendered.push({ renderer: "pdf", content });
      return Buffer.from("fake-pdf-bytes");
    };
  });

  afterEach(() => {
    (FilesRepo as any).create = originals.filesCreate;
    (s3 as any).uploadToS3 = originals.uploadToS3;
    (s3 as any).getPresignedGetUrl = originals.getPresignedGetUrl;
    (renderer as any).renderGeneratedDocx = originals.renderDocx;
    (renderer as any).renderGeneratedPdf = originals.renderPdf;
  });

  it("renders docx, uploads it, and records the file with chat-wonder metadata", async () => {
    const result = await GeneratedDocumentExportSvc.export(
      "1. First paragraph.\n\n2. Second paragraph.",
      "Opposition to Motion for Reconsideration",
      "docx",
    );

    expect(rendered).to.deep.equal([{ renderer: "docx", content: "1. First paragraph.\n\n2. Second paragraph." }]);
    expect(uploadCalls).to.have.length(1);
    expect(uploadCalls[0]!.key).to.match(/^generated-documents\/[0-9a-f-]{36}\.docx$/);
    expect(uploadCalls[0]!.contentType).to.equal(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );

    expect(filesCreateCalls).to.have.length(1);
    expect(filesCreateCalls[0]!.filename).to.equal("Opposition-to-Motion-for-Reconsideration.docx");
    expect(filesCreateCalls[0]!.s3Key).to.equal(uploadCalls[0]!.key);
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
    expect(rendered.map((r) => r.renderer)).to.deep.equal(["pdf"]);
    expect(uploadCalls[0]!.key).to.match(/\.pdf$/);
    expect(uploadCalls[0]!.contentType).to.equal("application/pdf");
  });

  it("sanitizes a documentName with special characters into a safe filename", async () => {
    await GeneratedDocumentExportSvc.export("Body.", "Dela Cruz v. Santos: Opp'n (Rev. 2)", "pdf");
    expect(filesCreateCalls[0]!.filename).to.match(/^[a-zA-Z0-9-_]+\.pdf$/);
  });
});
