/** GeneratedDocumentCtrl — #88, validation + glue only. No route exists yet (that's #87), and
 * every controller test elsewhere in this repo goes through supertest against a live route +
 * real Postgres — there's no lighter convention here to match. This is a deliberate one-off:
 * a direct mock-req/res unit test of the controller class in isolation, covering validation and
 * argument-order behavior now. The real end-to-end coverage (actual HTTP call, real route,
 * real auth) belongs in #87 once the route exists, per the same pattern as every other
 * controller test in this repo.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import type { Request, Response } from "express";
import GeneratedDocumentCtrl from "../src/controllers/generated-document.controller";
import GeneratedDocumentExportSvc from "../src/services/generated-document-export.service";
import HttpError from "../src/utils/http-error";

function mockRes() {
  const res = {
    statusCode: undefined as number | undefined,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res as unknown as Response & { statusCode?: number; body?: unknown };
}

describe("GeneratedDocumentCtrl.create", () => {
  const originalExport = GeneratedDocumentExportSvc.export;
  let exportCalls: { content: string; documentName: string; format: string }[];

  beforeEach(() => {
    exportCalls = [];
    (GeneratedDocumentExportSvc as any).export = async (content: string, documentName: string, format: string) => {
      exportCalls.push({ content, documentName, format });
      return { file: { id: "file-1", fileUrl: "https://s3.example/x", filename: "x.docx" } };
    };
  });

  afterEach(() => {
    (GeneratedDocumentExportSvc as any).export = originalExport;
  });

  it("calls the service with (content, documentName, format) in that order and returns 201", async () => {
    const req = { body: { documentName: "My Doc", content: "Body text.", format: "pdf" } } as Request;
    const res = mockRes();

    await GeneratedDocumentCtrl.create(req, res);

    expect(exportCalls).to.deep.equal([{ content: "Body text.", documentName: "My Doc", format: "pdf" }]);
    expect(res.statusCode).to.equal(201);
    expect(res.body).to.deep.equal({ file: { id: "file-1", fileUrl: "https://s3.example/x", filename: "x.docx" } });
  });

  it("defaults format to docx when omitted", async () => {
    const req = { body: { documentName: "My Doc", content: "Body text." } } as Request;
    await GeneratedDocumentCtrl.create(req, mockRes());
    expect(exportCalls[0]!.format).to.equal("docx");
  });

  it("rejects with a 400 HttpError when documentName is missing, without calling the service", async () => {
    const req = { body: { content: "Body text." } } as Request;
    try {
      await GeneratedDocumentCtrl.create(req, mockRes());
      expect.fail("expected HttpError to be thrown");
    } catch (e) {
      expect(e).to.be.instanceOf(HttpError);
      expect((e as HttpError).statusCode).to.equal(400);
    }
    expect(exportCalls).to.have.length(0);
  });

  it("rejects with a 400 HttpError when content is missing", async () => {
    const req = { body: { documentName: "My Doc" } } as Request;
    try {
      await GeneratedDocumentCtrl.create(req, mockRes());
      expect.fail("expected HttpError to be thrown");
    } catch (e) {
      expect(e).to.be.instanceOf(HttpError);
    }
    expect(exportCalls).to.have.length(0);
  });

  it("rejects with a 400 HttpError when format is not docx or pdf", async () => {
    const req = { body: { documentName: "My Doc", content: "Body text.", format: "txt" } } as Request;
    try {
      await GeneratedDocumentCtrl.create(req, mockRes());
      expect.fail("expected HttpError to be thrown");
    } catch (e) {
      expect(e).to.be.instanceOf(HttpError);
    }
    expect(exportCalls).to.have.length(0);
  });
});
