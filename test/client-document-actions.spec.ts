/** Removing, opening and retrying a case document from the client app (#574). No live Postgres:
 * Prisma delegates, repositories and services are monkeypatched on their CommonJS module objects,
 * same idiom as test/client-message-documents.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import jwt from "jsonwebtoken";
import request from "supertest";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import loginToken from "../src/utils/loginToken";
import DocumentRepo from "../src/repositories/document.repository";
import ClientCaseRepo from "../src/repositories/client-case.repository";
import ClientRequestRepo from "../src/repositories/client-request.repository";
import ClientCaseSvc, { type ClientWorkspace } from "../src/services/client-case.service";
import DocumentSvc from "../src/services/document.service";
import DocumentExtractionQueue from "../src/queues/document-extraction.queue";
import * as socket from "../src/lib/socket";
import { CLIENT_DOCUMENT_LINK_SECONDS } from "../src/constants/client-case.constants";
import { firmScope } from "../src/utils/workspace";

const workspace: ClientWorkspace = { id: "org-personal", role: "OWNER", tenantCode: "UK" };

const stashed: (() => void)[] = [];
function stash<T extends object>(target: T, keys: string[]) {
  const saved = keys.map((k) => [k, (target as any)[k]] as const);
  stashed.push(() => saved.forEach(([k, v]) => ((target as any)[k] = v)));
}

const uploadedAt = new Date("2026-10-23T09:30:00Z");

describe("Client document actions", () => {
  let role: string;
  let ragStatus: string;
  let deleted: unknown[] | null;
  let docLookups: unknown[][];
  let emitted: unknown[][];
  let statusSet: unknown[] | null;
  let enqueued: string[];
  let engaged: { requestId: string; lawyerId: string; client: { id: string; name: string } } | null;

  const call = (method: "get" | "post" | "delete", path: string, as = "client") =>
    request(app)[method](`/api/client/cases/case-1/documents/${path}`).set({ Authorization: `Bearer ${loginToken(as).accessToken}` });

  beforeEach(() => {
    stash(prisma.user as any, ["findUnique"]);
    stash(ClientCaseSvc, ["workspaceFor"]);
    stash(ClientCaseRepo, ["findById"]);
    stash(DocumentRepo, ["findOneForCase", "updateRagStatus"]);
    stash(DocumentSvc, ["delete"]);
    stash(ClientRequestRepo, ["findEngagedLawyerForCase"]);
    stash(DocumentExtractionQueue, ["enqueue"]);
    stash(socket, ["emitToUser"]);
    role = "USER";
    ragStatus = "FAILED";
    deleted = null;
    docLookups = [];
    emitted = [];
    statusSet = null;
    enqueued = [];
    engaged = null;
    (prisma.user as any).findUnique = async () => ({ role, name: "Sam Client", username: "sam.1234" });
    (ClientCaseSvc as any).workspaceFor = async (userId: string) => ({ ...workspace, id: userId === "other-client" ? "org-2" : workspace.id });
    (ClientCaseRepo as any).findById = async (id: string, orgId: string) =>
      id === "case-1" && orgId === workspace.id ? { id: "case-1", caseName: "Fired by my boss", consultations: [] } : null;
    (DocumentRepo as any).findOneForCase = async (...args: unknown[]) => {
      docLookups.push(args);
      return args[0] === "d1"
        ? { id: "d1", name: "Payslip.pdf", ragStatus, fileSize: 2048, createdAt: uploadedAt, file: { s3Key: "documents/abc.pdf" } }
        : null;
    };
    (DocumentRepo as any).updateRagStatus = async (...args: unknown[]) => {
      statusSet = args;
    };
    (DocumentSvc as any).delete = async (...args: unknown[]) => {
      deleted = args;
    };
    (ClientRequestRepo as any).findEngagedLawyerForCase = async () => engaged;
    (DocumentExtractionQueue as any).enqueue = (id: string) => enqueued.push(id);
    (socket as any).emitToUser = (...args: unknown[]) => emitted.push(args);
  });

  afterEach(() => {
    while (stashed.length) stashed.pop()!();
  });

  describe("who may call them", () => {
    const routes: ["get" | "post" | "delete", string][] = [
      ["delete", "d1"],
      ["get", "d1/url"],
      ["post", "d1/retry"],
    ];

    for (const [method, path] of routes) {
      it(`${method.toUpperCase()} ${path} refuses a lawyer with 403 CLIENT_ACCOUNT_ONLY`, async () => {
        role = "LAWYER";
        const res = await call(method, path, "lawyer");
        expect(res.status).to.equal(403);
        expect(res.body.code).to.equal("CLIENT_ACCOUNT_ONLY");
        expect(docLookups).to.deep.equal([]);
      });

      it(`${method.toUpperCase()} ${path} 404s for another client, before looking at the document`, async () => {
        const res = await call(method, path, "other-client");
        expect(res.status).to.equal(404);
        expect(docLookups).to.deep.equal([]);
      });
    }

    it("404s for a document that isn't on this case", async () => {
      expect((await call("delete", "d-elsewhere")).status).to.equal(404);
      expect(deleted).to.equal(null);
    });

    it("looks the document up on this case, in the client's workspace", async () => {
      await call("get", "d1/url");
      expect(docLookups).to.deep.equal([["d1", "case-1", firmScope("org-personal")]]);
    });
  });

  describe("DELETE /cases/:caseId/documents/:documentId", () => {
    it("deletes the document in the client's workspace", async () => {
      const res = await call("delete", "d1");
      expect(res.status).to.equal(204);
      expect(deleted).to.deep.equal(["d1", firmScope("org-personal"), "client"]);
    });

    it("tells the engaged lawyer live", async () => {
      engaged = { requestId: "req-1", lawyerId: "lawyer-1", client: { id: "client", name: "Sam Client" } };
      await call("delete", "d1");
      expect(emitted).to.deep.equal([
        ["lawyer-1", "engagement:document-removed", { requestId: "req-1", caseId: "case-1", documentId: "d1", filename: "Payslip.pdf" }],
      ]);
    });

    it("sends nothing when nobody is engaged on the case", async () => {
      await call("delete", "d1");
      expect(emitted).to.deep.equal([]);
    });
  });

  describe("GET /cases/:caseId/documents/:documentId/url", () => {
    it("hands back a short-lived inline file link", async () => {
      const before = Date.now();
      const res = await call("get", "d1/url");
      expect(res.status).to.equal(200);
      expect(res.body.url).to.match(/^\/files\//);
      const claims = jwt.decode(res.body.url.slice("/files/".length)) as any;
      expect(claims.s3Key).to.equal("documents/abc.pdf");
      expect(claims.filename).to.equal("Payslip.pdf");
      expect(claims.disposition).to.equal("inline");
      expect(claims.exp - claims.iat).to.equal(CLIENT_DOCUMENT_LINK_SECONDS);
      const expiresAt = Date.parse(res.body.expiresAt);
      expect(expiresAt).to.be.at.least(before + CLIENT_DOCUMENT_LINK_SECONDS * 1000 - 1000);
      expect(expiresAt).to.be.at.most(Date.now() + CLIENT_DOCUMENT_LINK_SECONDS * 1000);
    });
  });

  describe("POST /cases/:caseId/documents/:documentId/retry", () => {
    it("reads a FAILED document again", async () => {
      const res = await call("post", "d1/retry");
      expect(res.status).to.equal(200);
      expect(statusSet).to.deep.equal(["d1", "PENDING"]);
      expect(enqueued).to.deep.equal(["d1"]);
      expect(res.body).to.deep.equal({
        id: "d1",
        name: "Payslip.pdf",
        status: "PENDING",
        size: 2048,
        uploadedAt: uploadedAt.toISOString(),
        createdAt: uploadedAt.toISOString(),
      });
    });

    for (const status of ["READY", "PENDING"]) {
      it(`refuses a ${status} document with 409 NOT_FAILED`, async () => {
        ragStatus = status;
        const res = await call("post", "d1/retry");
        expect(res.status).to.equal(409);
        expect(res.body.code).to.equal("NOT_FAILED");
        expect(statusSet).to.equal(null);
        expect(enqueued).to.deep.equal([]);
      });
    }
  });

  describe("the case's documents", () => {
    it("carry their size and when they were uploaded", async () => {
      (ClientCaseRepo as any).findById = async () => ({
        id: "case-1",
        caseName: "Fired by my boss",
        practiceArea: "EMPLOYMENT",
        parties: [],
        consultations: [],
        documents: [
          { id: "d1", name: "Payslip.pdf", ragStatus: "READY", fileSize: 2048, createdAt: uploadedAt },
          { id: "d2", name: "Letter.pdf", ragStatus: "PENDING", fileSize: null, createdAt: uploadedAt },
        ],
      });
      const dto = await ClientCaseSvc.get(workspace, "case-1");
      expect(dto.documents).to.deep.equal([
        { id: "d1", name: "Payslip.pdf", status: "READY", size: 2048, uploadedAt, createdAt: uploadedAt },
        { id: "d2", name: "Letter.pdf", status: "PENDING", size: null, uploadedAt, createdAt: uploadedAt },
      ]);
    });
  });
});
