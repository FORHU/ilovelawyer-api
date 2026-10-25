/** The client app's cases (ClientCaseSvc, /api/client): client accounts only, everything in the
 * client's personal workspace, and a thin mapping onto the lawyer app's Case, Consultation and
 * Document. No live Postgres: repositories and services are monkeypatched on their CommonJS
 * module objects, same idiom as test/client-app-role.spec.ts. */
import { firmScope } from "../src/utils/workspace";
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import type { Request } from "express";
import prisma from "../src/lib/prisma";
import ClientCaseSvc, { type ClientWorkspace } from "../src/services/client-case.service";
import ClientCaseRepo from "../src/repositories/client-case.repository";
import ClientPaymentRepo from "../src/repositories/client-payment.repository";
import OrganizationMemberRepo from "../src/repositories/organization-member.repository";
import OrganizationSvc from "../src/services/organization.service";
import CaseSvc from "../src/services/case.service";
import ChatSvc from "../src/services/chat.service";
import DocumentSvc from "../src/services/document.service";
import DocumentRepo from "../src/repositories/document.repository";
import ClientRequestRepo from "../src/repositories/client-request.repository";
import ClientRequestSvc from "../src/services/client-request.service";
import requireClientAccount from "../src/middleware/require-client-account.middleware";
import clientRoute from "../src/routes/client.route";
import { createClientCaseSchema, sendClientMessageSchema, updateClientCaseSchema } from "../src/validation/client-case.validation";
import { listRoutes } from "./support/list-routes";
import * as socket from "../src/lib/socket";

function stash<T extends object>(target: T, keys: string[]) {
  const saved = keys.map((k) => [k, (target as any)[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

async function errorOf(promise: Promise<unknown>): Promise<{ status?: number; code?: string } | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err: any) {
    return { status: err.statusCode, code: err.code };
  }
}

const workspace: ClientWorkspace = { id: "org-personal", role: "OWNER", tenantCode: "UK" };

function caseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "case-1",
    caseName: "Dismissed without notice",
    practiceArea: "EMPLOYMENT",
    ukJurisdiction: "England and Wales",
    jurisdiction: "Leeds",
    clientSide: "CLAIMANT",
    parties: [{ id: "p1", name: "Acme Ltd", designation: "Opposing party" }],
    documents: [{ id: "d1", name: "Contract.pdf", ragStatus: "READY", createdAt: new Date("2026-10-20") }],
    consultations: [{ id: "cons-1" }],
    clientCredits: 50,
    createdAt: new Date("2026-10-20"),
    updatedAt: new Date("2026-10-21"),
    ...overrides,
  };
}

const personalMember = {
  organizationId: "org-personal",
  role: "OWNER",
  status: "ACCEPTED",
  organization: { isPersonal: true, tenant: { code: "UK" } },
};

describe("Client app cases", () => {
  describe("requireClientAccount", () => {
    let restore: () => void;
    let role: string;
    const users = prisma.user as any;

    beforeEach(() => {
      restore = stash(users, ["findUnique"]);
      const restoreSvc = stash(ClientCaseSvc, ["workspaceFor"]);
      const prev = restore;
      restore = () => {
        prev();
        restoreSvc();
      };
      role = "USER";
      users.findUnique = async () => ({ role, name: "Sam Client", username: "sam.1234" });
      (ClientCaseSvc as any).workspaceFor = async () => workspace;
    });
    afterEach(() => restore());

    const run = async () => {
      const req = { user: { userId: "u1" } } as unknown as Request;
      let nextCalled = false;
      await requireClientAccount(req, {} as any, () => {
        nextCalled = true;
      });
      return { req, nextCalled };
    };

    it("runs a client's request in their personal workspace", async () => {
      const { req, nextCalled } = await run();
      expect(nextCalled).to.equal(true);
      expect(req.workspace).to.deep.include({ organizationId: workspace.id, ownerId: null, role: workspace.role, tenantCode: workspace.tenantCode });
    });

    it("refuses a lawyer or admin account, whatever app sent it", async () => {
      for (const other of ["LAWYER", "ADMIN"]) {
        role = other;
        expect(await errorOf(run())).to.deep.equal({ status: 403, code: "CLIENT_ACCOUNT_ONLY" });
      }
    });
  });

  describe("workspaceFor", () => {
    let restore: () => void;
    let member: unknown;
    let created: unknown[];

    beforeEach(() => {
      const a = stash(OrganizationMemberRepo, ["findAnyForUser"]);
      const b = stash(OrganizationSvc, ["create"]);
      restore = () => {
        a();
        b();
      };
      member = null;
      created = [];
      (OrganizationMemberRepo as any).findAnyForUser = async () => member;
      (OrganizationSvc as any).create = async (...args: unknown[]) => {
        created.push(args);
        member = personalMember;
      };
    });
    afterEach(() => restore());

    it("makes a personal workspace on the UK tenant the first time", async () => {
      const ws = await ClientCaseSvc.workspaceFor("u1", "Sam Client");
      expect(created).to.deep.equal([["u1", "Sam Client", undefined, "UK", true]]);
      expect(ws).to.deep.equal(workspace);
    });

    it("reuses the one they have", async () => {
      member = personalMember;
      await ClientCaseSvc.workspaceFor("u1", "Sam Client");
      expect(created).to.deep.equal([]);
    });

    it("refuses an account that belongs to a real organization", async () => {
      member = { ...personalMember, organization: { isPersonal: false, tenant: { code: "UK" } } };
      expect(await errorOf(ClientCaseSvc.workspaceFor("u1", "Sam Client"))).to.deep.equal({ status: 409, code: "NOT_A_CLIENT_WORKSPACE" });
    });
  });

  describe("cases, chat and documents", () => {
    let restore: () => void;
    let row: ReturnType<typeof caseRow> | null;
    let calls: Record<string, unknown[]>;
    let live: { id: string; status: string } | null;
    let caseDocs: { id: string; name: string; ragStatus: string }[];
    let creditsSpent: number;

    beforeEach(() => {
      live = null;
      caseDocs = [];
      creditsSpent = 0;
      const fns = [
        stash(ClientCaseRepo, ["findById", "findAnyById", "list", "clearReadiness"]),
        stash(CaseSvc, ["create", "update", "archive", "unarchive", "delete"]),
        stash(ClientRequestSvc, ["withdraw"]),
        stash(ChatSvc, ["createConsultation", "listMessages", "enqueueChatGeneration"]),
        // Paying and credits are test/client-billing.spec.ts's; here a payment is always good.
        stash(ClientPaymentRepo, ["claimCasePayment", "attachToCase", "spendCredit", "addCredits"]),
        stash(DocumentSvc, ["create"]),
        stash(DocumentRepo, ["findManyForCase"]),
        stash(ClientRequestRepo, ["findEngagedLawyerForCase", "findLiveForCase"]),
        stash(socket, ["emitToUser"]),
      ];
      (ClientPaymentRepo as any).claimCasePayment = async () => 50;
      (ClientPaymentRepo as any).attachToCase = async () => undefined;
      (ClientPaymentRepo as any).spendCredit = async () => {
        creditsSpent++;
        return true;
      };
      (DocumentRepo as any).findManyForCase = async (...args: unknown[]) => {
        calls.findManyForCase = args;
        return caseDocs.filter((d) => (args[0] as string[]).includes(d.id));
      };
      (ClientPaymentRepo as any).addCredits = async () => 50;
      (DocumentSvc as any).create = async () => ({ id: "d2", name: "Payslip.pdf", ragStatus: "PENDING", createdAt: new Date("2026-10-22") });
      (ClientRequestRepo as any).findEngagedLawyerForCase = async () => null;
      (ClientRequestRepo as any).findLiveForCase = async () => live;
      (socket as any).emitToUser = () => {};
      restore = () => fns.forEach((f) => f());
      row = caseRow();
      calls = {};
      const record = (name: string) => (...args: unknown[]) => {
        calls[name] = args;
      };
      (ClientCaseRepo as any).findById = async (id: string, orgId: string) => (row && id === row.id && orgId === workspace.id ? row : null);
      (ClientCaseRepo as any).findAnyById = (ClientCaseRepo as any).findById;
      (ClientCaseRepo as any).clearReadiness = async (...args: unknown[]) => record("clearReadiness")(...args);
      (CaseSvc as any).update = async (...args: unknown[]) => record("caseUpdate")(...args);
      (CaseSvc as any).archive = async (...args: unknown[]) => record("caseArchive")(...args);
      (CaseSvc as any).unarchive = async (...args: unknown[]) => record("caseUnarchive")(...args);
      (CaseSvc as any).delete = async (...args: unknown[]) => record("caseDelete")(...args);
      (ClientRequestSvc as any).withdraw = async (...args: unknown[]) => record("withdraw")(...args);
      (CaseSvc as any).create = async (...args: unknown[]) => {
        record("caseCreate")(...args);
        return { id: "case-1" };
      };
      (ChatSvc as any).createConsultation = async (...args: unknown[]) => {
        record("createConsultation")(...args);
        return { id: "cons-new" };
      };
      (ChatSvc as any).enqueueChatGeneration = async (...args: unknown[]) => {
        record("enqueue")(...args);
        return { messageId: "m9", sessionId: "s", replyStatus: "PENDING" };
      };
    });
    afterEach(() => restore());

    it("maps a client case onto a lawyer Case, and starts its chat", async () => {
      const dto = await ClientCaseSvc.create(workspace, "u1", {
        paymentId: "pay-1",
        title: "Dismissed without notice after three years in the job, by text message, on a Sunday evening before my shift",
        area: "EMPLOYMENT",
        ukJurisdiction: "England and Wales",
        where: "Leeds",
        side: "CLAIMANT",
        others: [{ name: "Acme Ltd", role: "Opposing party" }],
      });
      // The client's personal workspace is an organization, scoped like a firm.
      expect(calls.caseCreate).to.deep.equal([
        firmScope("org-personal"),
        "u1",
        "OWNER",
        {
          caseName: "Dismissed without notice after three years in the job, by text message, on a Sunday evening before my shift",
          practiceArea: "EMPLOYMENT",
          ukJurisdiction: "England and Wales",
          jurisdiction: "Leeds",
          clientSide: "CLAIMANT",
          parties: [{ name: "Acme Ltd", designation: "Opposing party" }],
        },
      ]);
      const [, , title, caseId] = calls.createConsultation as [string, string, string, string];
      expect(title.length).to.equal(80);
      expect(caseId).to.equal("case-1");
      expect(dto).to.include({ id: "case-1", title: "Dismissed without notice", area: "EMPLOYMENT", where: "Leeds", credits: 50 });
      expect(dto.others).to.deep.equal([{ id: "p1", name: "Acme Ltd", role: "Opposing party" }]);
      expect(dto.documents).to.deep.equal([{ id: "d1", name: "Contract.pdf", status: "READY", createdAt: new Date("2026-10-20") }]);
    });

    it("stores what the client said happened and wants as the case's notes", async () => {
      await ClientCaseSvc.create(workspace, "u1", {
        paymentId: "pay-1",
        title: "Holiday refund",
        area: "CONSUMER",
        ukJurisdiction: null,
        notes: "What happened: Flight cancelled.\n\nWhat I want: A refund.",
      });
      expect((calls.caseCreate as any[])[3]).to.include({ notes: "What happened: Flight cancelled.\n\nWhat I want: A refund." });
    });

    it("stores no UK jurisdiction for a case outside the UK", async () => {
      await ClientCaseSvc.create(workspace, "u1", { paymentId: "pay-1", title: "Holiday refund", area: "CONSUMER", ukJurisdiction: null });
      expect((calls.caseCreate as any[])[3]).to.include({ ukJurisdiction: undefined, jurisdiction: undefined, clientSide: null });
    });

    it("shows only the user's and the AI's messages, and whether a reply is still coming", async () => {
      (ChatSvc as any).listMessages = async (...args: unknown[]) => {
        calls.listMessages = args;
        return [
          {
            id: "m1",
            role: "user",
            content: "Is this legal?",
            replyStatus: "DONE",
            createdAt: "t1",
            documents: [{ id: "d1", name: "Contract.pdf", ragStatus: "READY", fileUrl: "https://files/x", caseId: "case-1" }],
          },
          { id: "m2", role: "assistant", content: "Usually not.", replyStatus: null, createdAt: "t2", documents: [] },
          { id: "m3", role: "system", content: "internal", replyStatus: null, createdAt: "t3", documents: [] },
          { id: "m4", role: "user", content: "What now?", replyStatus: "PENDING", createdAt: "t4", documents: [] },
        ];
      };
      const result = await ClientCaseSvc.listMessages(workspace, "u1", "case-1");
      expect(calls.listMessages).to.deep.equal([firmScope("org-personal"), "u1", "cons-1"]);
      expect(result.replying).to.equal(true);
      expect(result.messages.map((m) => [m.id, m.role, m.replyStatus])).to.deep.equal([
        ["m1", "user", "DONE"],
        ["m2", "ai", null],
        ["m4", "user", "PENDING"],
      ]);
      // Only what the app shows under the message: no file link, no other document fields.
      expect(result.messages[0].documents).to.deep.equal([{ id: "d1", name: "Contract.pdf", status: "READY" }]);
      expect(result.messages[1].documents).to.deep.equal([]);
    });

    it("asks the AI in the case's consultation, on the UK tenant, scoped to the case", async () => {
      await ClientCaseSvc.sendMessage(workspace, "u1", "case-1", "What are my rights?");
      expect(calls.enqueue).to.deep.equal([firmScope("org-personal"), "UK", "u1", "cons-1", "", "What are my rights?", undefined, undefined, "case-1", undefined]);
      expect(calls.findManyForCase).to.equal(undefined);
    });

    describe("sending documents with a message", () => {
      it("attaches the case's READY documents to the message", async () => {
        caseDocs = [{ id: "d1", name: "Contract.pdf", ragStatus: "READY" }];
        await ClientCaseSvc.sendMessage(workspace, "u1", "case-1", "Read this", ["d1"]);
        expect(calls.findManyForCase).to.deep.equal([["d1"], "case-1", firmScope("org-personal")]);
        expect((calls.enqueue as unknown[]).slice(8)).to.deep.equal(["case-1", ["d1"]]);
        expect(creditsSpent).to.equal(1);
      });

      it("refuses a document still being read, by name, and keeps the credit", async () => {
        caseDocs = [
          { id: "d1", name: "Contract.pdf", ragStatus: "READY" },
          { id: "d2", name: "Payslip.pdf", ragStatus: "PENDING" },
        ];
        const err: any = await ClientCaseSvc.sendMessage(workspace, "u1", "case-1", "Read this", ["d1", "d2"]).catch((e) => e);
        expect(err.statusCode).to.equal(409);
        expect(err.code).to.equal("DOCUMENTS_NOT_READY");
        expect(err.message).to.equal("Still reading Payslip.pdf. Send again once it's ready.");
        expect(err.details).to.deep.equal({ documents: [{ id: "d2", name: "Payslip.pdf", status: "PENDING" }] });
        expect(calls.enqueue).to.equal(undefined);
        expect(creditsSpent).to.equal(0);
      });

      it("names every document not ready, and says when one couldn't be read", async () => {
        caseDocs = [
          { id: "d1", name: "A.pdf", ragStatus: "PENDING" },
          { id: "d2", name: "B.pdf", ragStatus: "PENDING" },
          { id: "d3", name: "C.pdf", ragStatus: "FAILED" },
        ];
        const err: any = await ClientCaseSvc.sendMessage(workspace, "u1", "case-1", "Read these", ["d1", "d2", "d3"]).catch((e) => e);
        expect(err.message).to.equal("Still reading A.pdf and B.pdf. Send again once they're ready. We couldn't read C.pdf. Upload it again to use it.");
      });

      it("404s a document that isn't on this case, without spending a credit", async () => {
        caseDocs = [{ id: "d1", name: "Contract.pdf", ragStatus: "READY" }];
        expect(await errorOf(ClientCaseSvc.sendMessage(workspace, "u1", "case-1", "Read this", ["d1", "other-case-doc"]))).to.deep.include({ status: 404 });
        expect(calls.enqueue).to.equal(undefined);
        expect(creditsSpent).to.equal(0);
      });

      it("takes a repeated id once", async () => {
        caseDocs = [{ id: "d1", name: "Contract.pdf", ragStatus: "READY" }];
        await ClientCaseSvc.sendMessage(workspace, "u1", "case-1", "Read this", ["d1", "d1"]);
        expect((calls.findManyForCase as unknown[])[0]).to.deep.equal(["d1"]);
        expect((calls.enqueue as unknown[])[9]).to.deep.equal(["d1"]);
      });
    });

    it("gives a case that lost its chat a new one", async () => {
      row = caseRow({ consultations: [] });
      await ClientCaseSvc.sendMessage(workspace, "u1", "case-1", "Hello");
      expect((calls.enqueue as unknown[])[3]).to.equal("cons-new");
    });

    it("answers 404 for a case that isn't in the client's workspace", async () => {
      row = null;
      expect(await errorOf(ClientCaseSvc.get(workspace, "case-1"))).to.deep.include({ status: 404 });
      expect(await errorOf(ClientCaseSvc.sendMessage(workspace, "u1", "case-1", "Hi"))).to.deep.include({ status: 404 });
      expect(await errorOf(ClientCaseSvc.presignDocument(workspace, "u1", "case-1", { filename: "a.pdf", contentType: "application/pdf" }))).to.deep.include({
        status: 404,
      });
    });

    describe("update", () => {
      it("changes only what was sent, and has the readiness check run again", async () => {
        await ClientCaseSvc.update(workspace, "u1", "case-1", { title: "Unfair dismissal", where: "", notes: "Sacked on 3 Oct. I want my job back." });
        expect(calls.caseUpdate).to.deep.equal(["case-1", { organizationId: "org-personal", ownerId: null }, "u1", { caseName: "Unfair dismissal", jurisdiction: null, notes: "Sacked on 3 Oct. I want my job back." }]);
        expect(calls.clearReadiness).to.deep.equal(["case-1"]);
      });

      it("maps the people and the side onto the Case", async () => {
        await ClientCaseSvc.update(workspace, "u1", "case-1", { side: "RESPONDENT", others: [{ name: "Bea Ltd", role: "Witness" }], ukJurisdiction: null });
        expect((calls.caseUpdate as any[])[3]).to.deep.equal({ clientSide: "RESPONDENT", parties: [{ name: "Bea Ltd", designation: "Witness" }], ukJurisdiction: null });
      });

      it("answers 404 for a case that is not the client's", async () => {
        row = null;
        expect(await errorOf(ClientCaseSvc.update(workspace, "u1", "case-1", { title: "x" }))).to.deep.include({ status: 404 });
        expect(calls.caseUpdate).to.equal(undefined);
      });

      it("fixes the type, place and people once a lawyer holds the request, but not the title", async () => {
        live = { id: "req-1", status: "CLAIMED" };
        for (const change of [{ area: "FAMILY" as const }, { ukJurisdiction: "Scotland" }, { others: [] }]) {
          expect(await errorOf(ClientCaseSvc.update(workspace, "u1", "case-1", change))).to.deep.equal({ status: 409, code: "CASE_LOCKED_BY_REQUEST" });
        }
        await ClientCaseSvc.update(workspace, "u1", "case-1", { title: "New title", area: "EMPLOYMENT", others: [{ name: "acme ltd", role: "Opposing party" }] });
        expect((calls.caseUpdate as any[])[3]).to.include({ caseName: "New title" });
      });

      it("keeps a case with an open request inside the UK", async () => {
        live = { id: "req-1", status: "ROUTED" };
        expect(await errorOf(ClientCaseSvc.update(workspace, "u1", "case-1", { ukJurisdiction: null }))).to.deep.equal({ status: 409, code: "CASE_LOCKED_BY_REQUEST" });
        await ClientCaseSvc.update(workspace, "u1", "case-1", { area: "FAMILY" });
        expect((calls.caseUpdate as any[])[3]).to.deep.equal({ practiceArea: "FAMILY" });
      });
    });

    describe("archive and remove", () => {
      it("archives a case with no request", async () => {
        await ClientCaseSvc.archive(workspace, "u1", "case-1");
        expect(calls.caseArchive).to.deep.equal(["case-1", { organizationId: "org-personal", ownerId: null }, "u1"]);
        expect(calls.withdraw).to.equal(undefined);
      });

      it("withdraws an open request nobody has committed to before it deletes", async () => {
        live = { id: "req-1", status: "ROUTED" };
        await ClientCaseSvc.remove(workspace, "u1", "case-1");
        expect(calls.withdraw).to.deep.equal(["u1", "req-1"]);
        expect(calls.caseDelete).to.deep.equal(["case-1", { organizationId: "org-personal", ownerId: null }, "u1"]);
      });

      it("refuses to delete or archive while a lawyer is confirmed or engaged", async () => {
        for (const status of ["CONFIRMED", "ENGAGED"]) {
          live = { id: "req-1", status };
          expect(await errorOf(ClientCaseSvc.remove(workspace, "u1", "case-1"))).to.deep.equal({ status: 409, code: "CASE_HAS_ACTIVE_ENGAGEMENT" });
          expect(await errorOf(ClientCaseSvc.archive(workspace, "u1", "case-1"))).to.deep.equal({ status: 409, code: "CASE_HAS_ACTIVE_ENGAGEMENT" });
        }
        expect(calls.caseDelete).to.equal(undefined);
        expect(calls.caseArchive).to.equal(undefined);
      });

      it("answers 404 for a case that is not the client's", async () => {
        row = null;
        expect(await errorOf(ClientCaseSvc.remove(workspace, "u1", "case-1"))).to.deep.include({ status: 404 });
        expect(await errorOf(ClientCaseSvc.unarchive(workspace, "u1", "case-1"))).to.deep.include({ status: 404 });
      });

      it("lists archived cases separately", async () => {
        let asked: unknown[] = [];
        (ClientCaseRepo as any).list = async (...args: unknown[]) => {
          asked = args;
          return [];
        };
        await ClientCaseSvc.list(workspace, true);
        expect(asked).to.deep.equal(["org-personal", "ARCHIVED"]);
        await ClientCaseSvc.list(workspace);
        expect(asked).to.deep.equal(["org-personal", "ACTIVE"]);
      });
    });

    describe("addDocument", () => {
      const file = { key: "k1", name: "Payslip.pdf" };

      it("tells the engaged lawyer live when the client adds a document to the case", async () => {
        (ClientRequestRepo as any).findEngagedLawyerForCase = async (caseId: string) =>
          caseId === "case-1" ? { requestId: "req-1", lawyerId: "lawyer-1", client: { id: "u1", name: "Jamie Lee" } } : null;
        const emitted: unknown[] = [];
        (socket as any).emitToUser = (userId: string, event: string, payload: unknown) => emitted.push([userId, event, payload]);

        await ClientCaseSvc.addDocument(workspace, "u1", "case-1", file);

        expect(emitted).to.deep.equal([
          [
            "lawyer-1",
            "engagement:document-added",
            { requestId: "req-1", caseId: "case-1", documentId: "d2", filename: "Payslip.pdf", submittedBy: { id: "u1", name: "Jamie Lee" }, submittedAt: new Date("2026-10-22").toISOString() },
          ],
        ]);
      });

      it("sends nothing when nobody is engaged on the case yet", async () => {
        const emitted: unknown[] = [];
        (socket as any).emitToUser = (...args: unknown[]) => emitted.push(args);

        await ClientCaseSvc.addDocument(workspace, "u1", "case-1", file);

        expect(emitted).to.deep.equal([]);
      });
    });
  });

  describe("validation", () => {
    const valid = { paymentId: "pay-1", title: "Holiday refund", area: "CONSUMER", ukJurisdiction: "Scotland" };

    it("needs the part of the UK, or null for outside it", () => {
      expect(createClientCaseSchema.validate(valid).error).to.equal(undefined);
      expect(createClientCaseSchema.validate({ ...valid, ukJurisdiction: null }).error).to.equal(undefined);
      expect(createClientCaseSchema.validate({ paymentId: "pay-1", title: "x", area: "CONSUMER" }).error).to.not.equal(undefined);
      expect(createClientCaseSchema.validate({ title: "x", area: "CONSUMER", ukJurisdiction: null }).error).to.not.equal(undefined);
      expect(createClientCaseSchema.validate({ ...valid, ukJurisdiction: "Wales" }).error).to.not.equal(undefined);
    });

    it("takes the notes from the wizard, with a length cap", () => {
      expect(createClientCaseSchema.validate({ ...valid, notes: "Sacked on 3 Oct." }).error).to.equal(undefined);
      expect(createClientCaseSchema.validate({ ...valid, notes: "x".repeat(2001) }).error).to.not.equal(undefined);
    });

    it("takes an edit with at least one field, from the same sets as a new case", () => {
      expect(updateClientCaseSchema.validate({}).error).to.not.equal(undefined);
      expect(updateClientCaseSchema.validate({ title: "New" }).error).to.equal(undefined);
      expect(updateClientCaseSchema.validate({ ukJurisdiction: null }).error).to.equal(undefined);
      expect(updateClientCaseSchema.validate({ area: "PERSONAL_INJURY" }).error).to.not.equal(undefined);
    });

    it("takes up to 5 documents with a message", () => {
      const ids = (n: number) => Array.from({ length: n }, (_, i) => `d${i}`);
      expect(sendClientMessageSchema.validate({ text: "Hi" }).error).to.equal(undefined);
      expect(sendClientMessageSchema.validate({ text: "Hi", documentIds: ids(5) }).error).to.equal(undefined);
      expect(sendClientMessageSchema.validate({ text: "Hi", documentIds: ids(6) }).error).to.not.equal(undefined);
      expect(sendClientMessageSchema.validate({ text: "Hi", documentIds: [""] }).error).to.not.equal(undefined);
    });

    it("only takes the client app's areas, and no personal injury", () => {
      expect(createClientCaseSchema.validate({ ...valid, area: "PERSONAL_INJURY" }).error).to.not.equal(undefined);
    });
  });

  it("serves exactly these routes", () => {
    expect(listRoutes(clientRoute).map((r) => `${r.method} ${r.path}`)).to.deep.equal([
      "GET /pricing",
      "POST /payments/case/quote",
      "POST /payments/case",
      "GET /payments/:paymentId",
      "GET /limits",
      "GET /cases",
      "POST /cases",
      "GET /cases/:caseId",
      "PATCH /cases/:caseId",
      "DELETE /cases/:caseId",
      "POST /cases/:caseId/archive",
      "POST /cases/:caseId/unarchive",
      "GET /cases/:caseId/messages",
      "POST /cases/:caseId/messages",
      "POST /cases/:caseId/documents/presign",
      "POST /cases/:caseId/documents",
      "GET /cases/:caseId/overview",
      "POST /cases/:caseId/overview/generate",
      "POST /cases/:caseId/top-ups",
      "GET /cases/:caseId/lawyer-readiness",
      "GET /lawyer-requests/consent",
      "GET /lawyer-requests/eligibility",
      "POST /lawyer-requests",
      "GET /lawyer-requests",
      "GET /lawyer-requests/:id",
      "POST /lawyer-requests/:id/withdraw",
      "POST /lawyer-requests/:id/confirm",
      "POST /lawyer-requests/:id/decline",
      "POST /lawyer-requests/:id/end",
      "POST /lawyer-requests/:id/feedback",
      "GET /lawyer-requests/:id/messages",
      "POST /lawyer-requests/:id/messages",
      "POST /lawyer-requests/:id/messages/read",
    ]);
  });
});
