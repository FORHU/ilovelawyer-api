/** POST /generated-document — the server-to-server route chat-wonder calls (#87). Goes through real HTTP with
 * supertest against the real route, the real apiKeyMiddleware and the real error handler; only the export service
 * (S3 / Postgres / rendering) and the configured key are stubbed, same monkeypatch idiom as the other specs.
 * Registration in routes/index.ts is #90 and is tested there.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import express from "express";
import request from "supertest";
import * as config from "../src/config";
import generatedDocumentRoute from "../src/routes/generated-document.route";
import errorHandler from "../src/middleware/error-handler.middleware";
import GeneratedDocumentExportSvc from "../src/services/generated-document-export.service";

const KEY = "test-chat-wonder-key";
const RESULT = { file: { id: "file-1", fileUrl: "https://s3.example/presigned/x.docx", filename: "Affidavit-of-Loss.docx" } };

const app = express();
app.use(express.json());
app.use("/generated-document", generatedDocumentRoute);
app.use(errorHandler);

describe("POST /generated-document", () => {
  const originals = { key: (config as any).CHAT_WONDER_API_KEY, exportFn: GeneratedDocumentExportSvc.export };
  let calls: unknown[][];

  beforeEach(() => {
    calls = [];
    (config as any).CHAT_WONDER_API_KEY = KEY;
    (GeneratedDocumentExportSvc as any).export = async (...args: unknown[]) => {
      calls.push(args);
      return RESULT;
    };
  });

  afterEach(() => {
    (config as any).CHAT_WONDER_API_KEY = originals.key;
    (GeneratedDocumentExportSvc as any).export = originals.exportFn;
  });

  it("rejects a request with no api key (401) without calling the service", async () => {
    const res = await request(app).post("/generated-document").send({ documentName: "Doc", content: "Body" });
    expect(res.status).to.equal(401);
    expect(calls).to.have.length(0);
  });

  it("rejects a request with the wrong api key (401) without calling the service", async () => {
    const res = await request(app).post("/generated-document").set("x-api-key", "nope").send({ documentName: "Doc", content: "Body" });
    expect(res.status).to.equal(401);
    expect(calls).to.have.length(0);
  });

  it("with the right key and a valid body returns 201 and the rendered file, calling the service with (content, documentName, format)", async () => {
    const res = await request(app)
      .post("/generated-document")
      .set("x-api-key", KEY)
      .send({ documentName: "Affidavit of Loss", content: "I, Juan, declare...", format: "pdf" });
    expect(res.status).to.equal(201);
    expect(res.body).to.deep.equal(RESULT);
    expect(calls).to.deep.equal([["I, Juan, declare...", "Affidavit of Loss", "pdf"]]);
  });

  it("defaults the format to docx", async () => {
    await request(app).post("/generated-document").set("x-api-key", KEY).send({ documentName: "Doc", content: "Body" });
    expect(calls[0]![2]).to.equal("docx");
  });

  it("returns 400 for an invalid body with the right key, without calling the service", async () => {
    const res = await request(app).post("/generated-document").set("x-api-key", KEY).send({ content: "Body" });
    expect(res.status).to.equal(400);
    expect(calls).to.have.length(0);
  });

  it("has no GET handler", async () => {
    const res = await request(app).get("/generated-document").set("x-api-key", KEY);
    expect(res.status).to.equal(404);
  });
});
