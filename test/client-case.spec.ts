/** The client app's cases (ClientCaseSvc, /api/client): client accounts only, everything in the
 * client's personal workspace, and a thin mapping onto the lawyer app's Case, Consultation and
 * Document. No live Postgres: repositories and services are monkeypatched on their CommonJS
 * module objects, same idiom as test/client-app-role.spec.ts. */
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
import requireClientAccount from "../src/middleware/require-client-account.middleware";
import clientRoute from "../src/routes/client.route";
import { createClientCaseSchema } from "../src/validation/client-case.validation";
import { listRoutes } from "./support/list-routes";

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
      expect(req.organization).to.deep.equal(workspace);
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

    beforeEach(() => {
      const fns = [
        stash(ClientCaseRepo, ["findById", "list"]),
        stash(CaseSvc, ["create"]),
        stash(ChatSvc, ["createConsultation", "listMessages", "enqueueChatGeneration"]),
        // Paying and credits are test/client-billing.spec.ts's; here a payment is always good.
        stash(ClientPaymentRepo, ["claimCasePayment", "attachToCase", "spendCredit", "addCredits"]),
      ];
      (ClientPaymentRepo as any).claimCasePayment = async () => 50;
      (ClientPaymentRepo as any).attachToCase = async () => undefined;
      (ClientPaymentRepo as any).spendCredit = async () => true;
      (ClientPaymentRepo as any).addCredits = async () => 50;
      restore = () => fns.forEach((f) => f());
      row = caseRow();
      calls = {};
      const record = (name: string) => (...args: unknown[]) => {
        calls[name] = args;
      };
      (ClientCaseRepo as any).findById = async (id: string, orgId: string) => (row && id === row.id && orgId === workspace.id ? row : null);
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
      expect(calls.caseCreate).to.deep.equal([
        "org-personal",
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

    it("stores no UK jurisdiction for a case outside the UK", async () => {
      await ClientCaseSvc.create(workspace, "u1", { paymentId: "pay-1", title: "Holiday refund", area: "CONSUMER", ukJurisdiction: null });
      expect((calls.caseCreate as any[])[3]).to.include({ ukJurisdiction: undefined, jurisdiction: undefined, clientSide: null });
    });

    it("shows only the user's and the AI's messages, and whether a reply is still coming", async () => {
      (ChatSvc as any).listMessages = async (...args: unknown[]) => {
        calls.listMessages = args;
        return [
          { id: "m1", role: "user", content: "Is this legal?", replyStatus: "DONE", createdAt: "t1" },
          { id: "m2", role: "assistant", content: "Usually not.", replyStatus: null, createdAt: "t2" },
          { id: "m3", role: "system", content: "internal", replyStatus: null, createdAt: "t3" },
          { id: "m4", role: "user", content: "What now?", replyStatus: "PENDING", createdAt: "t4" },
        ];
      };
      const result = await ClientCaseSvc.listMessages(workspace, "u1", "case-1");
      expect(calls.listMessages).to.deep.equal(["org-personal", "u1", "cons-1"]);
      expect(result.replying).to.equal(true);
      expect(result.messages.map((m) => [m.id, m.role, m.replyStatus])).to.deep.equal([
        ["m1", "user", "DONE"],
        ["m2", "ai", null],
        ["m4", "user", "PENDING"],
      ]);
    });

    it("asks the AI in the case's consultation, on the UK tenant, scoped to the case", async () => {
      await ClientCaseSvc.sendMessage(workspace, "u1", "case-1", "What are my rights?");
      expect(calls.enqueue).to.deep.equal(["org-personal", "UK", "u1", "cons-1", "", "What are my rights?", undefined, undefined, "case-1"]);
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

    it("only takes the client app's areas, and no personal injury", () => {
      expect(createClientCaseSchema.validate({ ...valid, area: "PERSONAL_INJURY" }).error).to.not.equal(undefined);
    });
  });

  it("serves exactly these routes", () => {
    expect(listRoutes(clientRoute).map((r) => `${r.method} ${r.path}`)).to.deep.equal([
      "GET /pricing",
      "POST /payments/case/quote",
      "POST /payments/case",
      "GET /cases",
      "POST /cases",
      "GET /cases/:caseId",
      "GET /cases/:caseId/messages",
      "POST /cases/:caseId/messages",
      "POST /cases/:caseId/documents/presign",
      "POST /cases/:caseId/documents",
      "POST /cases/:caseId/top-ups",
    ]);
  });
});
