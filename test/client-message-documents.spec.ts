/** Documents sent with a client's chat message (#567): which documents a message can link, and
 * the client route's checks. No live Postgres: Prisma delegates, repositories and services are
 * monkeypatched on their CommonJS module objects, same idiom as test/client-case.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import request from "supertest";
import app from "../src/app";
import prisma from "../src/lib/prisma";
import loginToken from "../src/utils/loginToken";
import DocumentRepo from "../src/repositories/document.repository";
import ClientCaseRepo from "../src/repositories/client-case.repository";
import ClientPaymentRepo from "../src/repositories/client-payment.repository";
import ClientCaseSvc, { type ClientWorkspace } from "../src/services/client-case.service";
import ChatSvc from "../src/services/chat.service";
import ConsentSvc from "../src/services/consent.service";
import { firmScope } from "../src/utils/workspace";

const workspace: ClientWorkspace = { id: "org-personal", role: "OWNER", tenantCode: "UK" };

const stashed: (() => void)[] = [];
function stash<T extends object>(target: T, keys: string[]) {
  const saved = keys.map((k) => [k, (target as any)[k]] as const);
  stashed.push(() => saved.forEach(([k, v]) => ((target as any)[k] = v)));
}

describe("Client message documents", () => {
  afterEach(() => {
    while (stashed.length) stashed.pop()!();
  });

  describe("DocumentRepo.linkToMessage", () => {
    let where: any;
    const capture = () => {
      stash(prisma.document as any, ["updateMany"]);
      (prisma.document as any).updateMany = async (args: any) => {
        where = args.where;
        return { count: 1 };
      };
    };

    it("links a case document that has no consultation", async () => {
      capture();
      await DocumentRepo.linkToMessage(["d1"], "m1", firmScope("org-personal"), "cons-1", "u1", "case-1");
      expect(where.id).to.deep.equal({ in: ["d1"] });
      expect(where.AND[1]).to.deep.equal({ OR: [{ consultationId: "cons-1" }, { caseId: "case-1" }] });
    });

    it("links only by consultation when there is no case", async () => {
      capture();
      await DocumentRepo.linkToMessage(["d1"], "m1", firmScope("org-personal"), "cons-1", "u1");
      expect(where.AND[1]).to.deep.equal({ OR: [{ consultationId: "cons-1" }] });
    });
  });

  describe("DocumentRepo.findManyForCase", () => {
    it("looks only at the case's active documents in the workspace", async () => {
      let args: any;
      stash(prisma.document as any, ["findMany"]);
      (prisma.document as any).findMany = async (a: any) => {
        args = a;
        return [{ id: "d1", name: "Contract.pdf", ragStatus: "READY" }];
      };
      const rows = await DocumentRepo.findManyForCase(["d1"], "case-1", firmScope("org-personal"));
      expect(args.where).to.deep.equal({ id: { in: ["d1"] }, caseId: "case-1", status: "ACTIVE", organizationId: "org-personal" });
      expect(args.select).to.deep.equal({ id: true, name: true, ragStatus: true });
      expect(rows).to.deep.equal([{ id: "d1", name: "Contract.pdf", ragStatus: "READY" }]);
    });
  });

  describe("POST /api/client/cases/:caseId/messages with documentIds", () => {
    let role: string;
    let ragStatus: string;
    let enqueued: unknown[] | null;
    const send = (as: string) =>
      request(app)
        .post("/api/client/cases/case-1/messages")
        .set({ Authorization: `Bearer ${loginToken(as).accessToken}` })
        .send({ text: "Read this", documentIds: ["d1"] });

    beforeEach(() => {
      stash(prisma.user as any, ["findUnique"]);
      stash(ClientCaseSvc, ["workspaceFor"]);
      stash(ConsentSvc, ["assertAllowed"]);
      stash(ClientCaseRepo, ["findById"]);
      stash(DocumentRepo, ["findManyForCase"]);
      stash(ClientPaymentRepo, ["spendCredit", "addCredits"]);
      stash(ChatSvc, ["enqueueChatGeneration"]);
      role = "USER";
      ragStatus = "READY";
      enqueued = null;
      (prisma.user as any).findUnique = async () => ({ role, name: "Sam Client", username: "sam.1234" });
      (ClientCaseSvc as any).workspaceFor = async (userId: string) => ({ ...workspace, id: userId === "other-client" ? "org-2" : workspace.id });
      (ConsentSvc as any).assertAllowed = async () => undefined;
      (ClientCaseRepo as any).findById = async (id: string, orgId: string) =>
        id === "case-1" && orgId === workspace.id ? { id: "case-1", caseName: "Fired by my boss", consultations: [{ id: "cons-1" }] } : null;
      (DocumentRepo as any).findManyForCase = async () => [{ id: "d1", name: "Payslip.pdf", ragStatus }];
      (ClientPaymentRepo as any).spendCredit = async () => true;
      (ClientPaymentRepo as any).addCredits = async () => 50;
      (ChatSvc as any).enqueueChatGeneration = async (...args: unknown[]) => {
        enqueued = args;
        return { messageId: "m9", sessionId: "s", replyStatus: "PENDING" };
      };
    });

    it("sends the client's READY document with the message", async () => {
      const res = await send("client");
      expect(res.status).to.equal(202);
      expect(enqueued?.[9]).to.deep.equal(["d1"]);
    });

    it("refuses a document still being read with 409 and its name", async () => {
      ragStatus = "PENDING";
      const res = await send("client");
      expect(res.status).to.equal(409);
      expect(res.body.code).to.equal("DOCUMENTS_NOT_READY");
      expect(res.body.message).to.equal("Still reading Payslip.pdf. Send again once it's ready.");
      expect(res.body.documents).to.deep.equal([{ id: "d1", name: "Payslip.pdf", status: "PENDING" }]);
      expect(enqueued).to.equal(null);
    });

    it("refuses a lawyer with 403 CLIENT_ACCOUNT_ONLY", async () => {
      role = "LAWYER";
      const res = await send("lawyer");
      expect(res.status).to.equal(403);
      expect(res.body.code).to.equal("CLIENT_ACCOUNT_ONLY");
      expect(enqueued).to.equal(null);
    });

    it("404s for another client", async () => {
      expect((await send("other-client")).status).to.equal(404);
      expect(enqueued).to.equal(null);
    });
  });
});
