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
import ClientBillingSvc from "../src/services/client-billing.service";
import OrganizationMemberRepo from "../src/repositories/organization-member.repository";
import OrganizationSvc from "../src/services/organization.service";
import CaseSvc from "../src/services/case.service";
import IntakeChatSvc from "../src/services/intake-chat.service";
import DocumentSvc from "../src/services/document.service";
import DocumentRepo from "../src/repositories/document.repository";
import ClientRequestRepo from "../src/repositories/client-request.repository";
import ClientRequestSvc from "../src/services/client-request.service";
import CaseAreaRepo from "../src/repositories/case-area.repository";
import requireClientAccount from "../src/middleware/require-client-account.middleware";
import clientRoute from "../src/routes/client.route";
import ClientCaseCtrl from "../src/controllers/client-case.controller";
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

/** The UK case areas, as CaseAreaRepo.list gives them back: RETIRED is switched off. */
const CASE_AREAS = [
  ["EMPLOYMENT", "Employment"],
  ["CONSUMER", "Consumer"],
  ["FAMILY", "Family"],
  ["RETIRED", "Retired"],
  ["OTHER", "Other"],
].map(([code, name], sortOrder) => ({ id: code, country: "UK", code, name, description: "", isActive: code !== "RETIRED", sortOrder }));

function caseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "case-1",
    caseName: "Dismissed without notice",
    caseAreas: ["EMPLOYMENT"],
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
        stash(IntakeChatSvc, ["listMessages", "enqueueIntakeGeneration"]),
        // Credits are test/client-billing.spec.ts's; here a new case starts with 50.
        stash(ClientPaymentRepo, ["spendCredit", "addCredits"]),
        stash(ClientBillingSvc, ["pricing"]),
        stash(DocumentSvc, ["create"]),
        stash(DocumentRepo, ["findManyForCase"]),
        stash(ClientRequestRepo, ["findEngagedLawyerForCase", "findLiveForCase"]),
        stash(socket, ["emitToUser"]),
        stash(CaseAreaRepo, ["list"]),
      ];
      (CaseAreaRepo as any).list = async () => CASE_AREAS;
      (ClientBillingSvc as any).pricing = async () => ({ case: { credits: 50 }, topUpPacks: [], defaultPackId: null });
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
      (IntakeChatSvc as any).enqueueIntakeGeneration = async (...args: unknown[]) => {
        record("enqueue")(...args);
        return { messageId: "m9", sessionId: "s", replyStatus: "PENDING" };
      };
    });
    afterEach(() => restore());

    it("maps a client case onto a lawyer Case — no chat thread started yet, the intake pipeline needs none", async () => {
      const dto = await ClientCaseSvc.create(workspace, "u1", {
        title: "Dismissed without notice after three years in the job, by text message, on a Sunday evening before my shift",
        areas: ["EMPLOYMENT"],
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
          caseAreas: ["EMPLOYMENT"],
          ukJurisdiction: "England and Wales",
          jurisdiction: "Leeds",
          clientSide: "CLAIMANT",
          parties: [{ name: "Acme Ltd", designation: "Opposing party" }],
          // No budget given: "Not sure".
          budgetMinMinor: null,
          budgetMaxMinor: null,
          budgetFeePreference: null,
          // Free: no payment, and the case is written with the tenant's new-case credits.
          clientCredits: 50,
        },
      ]);
      expect(calls.enqueue).to.equal(undefined);
      expect(dto).to.include({ id: "case-1", title: "Dismissed without notice", area: "EMPLOYMENT", where: "Leeds", credits: 50 });
      expect(dto.areas).to.deep.equal([{ code: "EMPLOYMENT", name: "Employment" }]);
      expect(dto.others).to.deep.equal([{ id: "p1", name: "Acme Ltd", role: "Opposing party" }]);
      expect(dto.documents).to.deep.equal([
        { id: "d1", name: "Contract.pdf", status: "READY", size: null, uploadedAt: new Date("2026-10-20"), createdAt: new Date("2026-10-20") },
      ]);
    });

    it("stores what the client said happened and wants as the case's notes", async () => {
      await ClientCaseSvc.create(workspace, "u1", {
        title: "Holiday refund",
        areas: ["CONSUMER"],
        ukJurisdiction: null,
        notes: "What happened: Flight cancelled.\n\nWhat I want: A refund.",
      });
      expect((calls.caseCreate as any[])[3]).to.include({ notes: "What happened: Flight cancelled.\n\nWhat I want: A refund." });
    });

    it("stores the client's budget as a low and a high in pence, and returns it", async () => {
      row = caseRow({ budgetMinMinor: 50_000, budgetMaxMinor: 150_000, budgetFeePreference: "FIXED_FEE" });
      const dto = await ClientCaseSvc.create(workspace, "u1", {
        title: "Dismissed",
        areas: ["EMPLOYMENT"],
        ukJurisdiction: "England and Wales",
        budget: { minMinor: 50_000, maxMinor: 150_000, feePreference: "FIXED_FEE" },
      });
      expect((calls.caseCreate as any[])[3]).to.include({ budgetMinMinor: 50_000, budgetMaxMinor: 150_000, budgetFeePreference: "FIXED_FEE" });
      expect(dto.budget).to.deep.equal({ minMinor: 50_000, maxMinor: 150_000, feePreference: "FIXED_FEE" });
    });

    it("returns no budget for a case without one", async () => {
      expect((await ClientCaseSvc.get(workspace, "case-1")).budget).to.equal(null);
    });

    it("stores no UK jurisdiction for a case outside the UK", async () => {
      await ClientCaseSvc.create(workspace, "u1", { title: "Holiday refund", areas: ["CONSUMER"], ukJurisdiction: null });
      expect((calls.caseCreate as any[])[3]).to.include({ ukJurisdiction: undefined, jurisdiction: undefined, clientSide: null });
    });

    it("takes several areas, each once, and shows them in the list's order", async () => {
      row = caseRow({ caseAreas: ["FAMILY", "EMPLOYMENT"] });
      await ClientCaseSvc.create(workspace, "u1", { title: "Split", areas: ["FAMILY", "EMPLOYMENT", "FAMILY"], ukJurisdiction: null });
      expect((calls.caseCreate as any[])[3].caseAreas).to.deep.equal(["FAMILY", "EMPLOYMENT"]);
      expect((await ClientCaseSvc.get(workspace, "case-1")).areas.map((a) => a.code)).to.deep.equal(["EMPLOYMENT", "FAMILY"]);
    });

    it("refuses an area not on the list, or switched off, before the case is made", async () => {
      for (const [areas, code] of [[["PERSONAL_INJURY"], "UNKNOWN_CASE_AREA"], [["RETIRED"], "CASE_AREA_INACTIVE"], [[], "CASE_AREA_REQUIRED"]] as const) {
        expect(await errorOf(ClientCaseSvc.create(workspace, "u1", { title: "x", areas: [...areas], ukJurisdiction: null }))).to.deep.equal({ status: 400, code });
      }
      expect(calls.caseCreate).to.equal(undefined);
    });

    it("lets a case keep a switched-off area it already has, but not add one", async () => {
      row = caseRow({ caseAreas: ["RETIRED"] });
      await ClientCaseSvc.update(workspace, "u1", "case-1", { areas: ["RETIRED", "FAMILY"] });
      expect((calls.caseUpdate as any[])[3]).to.deep.equal({ caseAreas: ["RETIRED", "FAMILY"] });
      row = caseRow();
      expect(await errorOf(ClientCaseSvc.update(workspace, "u1", "case-1", { areas: ["RETIRED"] }))).to.deep.equal({ status: 400, code: "CASE_AREA_INACTIVE" });
    });

    it("shows only the user's and the AI's messages, and whether a reply is still coming", async () => {
      (IntakeChatSvc as any).listMessages = async (...args: unknown[]) => {
        calls.listMessages = args;
        return {
          replying: true,
          messages: [
            { id: "m1", role: "user", text: "Is this legal?", replyStatus: "DONE", documentIds: ["d1"], createdAt: "t1" },
            { id: "m2", role: "ai", text: "Usually not.", replyStatus: null, documentIds: [], createdAt: "t2" },
            { id: "m4", role: "user", text: "What now?", replyStatus: "PENDING", documentIds: [], createdAt: "t4" },
          ],
        };
      };
      const result = await ClientCaseSvc.listMessages(workspace, "u1", "case-1");
      expect(calls.listMessages).to.deep.equal([workspace, "u1", "case-1"]);
      expect(result.replying).to.equal(true);
      expect(result.messages.map((m) => [m.id, m.role, m.replyStatus])).to.deep.equal([
        ["m1", "user", "DONE"],
        ["m2", "ai", null],
        ["m4", "user", "PENDING"],
      ]);
      // The case's documents attached to the user's turn — ids only; IntakeChatSvc.listMessages
      // doesn't resolve names/status inline, the frontend already has a document-list endpoint.
      expect(result.messages[0].documentIds).to.deep.equal(["d1"]);
      expect(result.messages[1].documentIds).to.deep.equal([]);
    });

    it("asks the AI on the intake pipeline's own queue, scoped to the case", async () => {
      await ClientCaseSvc.sendMessage(workspace, "u1", "case-1", "What are my rights?");
      expect(calls.enqueue).to.deep.equal([workspace, "u1", "case-1", "What are my rights?", undefined]);
      expect(calls.findManyForCase).to.equal(undefined);
    });

    describe("sending documents with a message", () => {
      it("attaches the case's READY documents to the message", async () => {
        caseDocs = [{ id: "d1", name: "Contract.pdf", ragStatus: "READY" }];
        await ClientCaseSvc.sendMessage(workspace, "u1", "case-1", "Read this", ["d1"]);
        expect(calls.findManyForCase).to.deep.equal([["d1"], "case-1", firmScope("org-personal")]);
        expect(calls.enqueue).to.deep.equal([workspace, "u1", "case-1", "Read this", ["d1"]]);
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
        expect((calls.enqueue as unknown[])[4]).to.deep.equal(["d1"]);
      });
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
        for (const change of [{ areas: ["FAMILY"] }, { areas: ["EMPLOYMENT", "FAMILY"] }, { ukJurisdiction: "Scotland" }, { others: [] }]) {
          expect(await errorOf(ClientCaseSvc.update(workspace, "u1", "case-1", change))).to.deep.equal({ status: 409, code: "CASE_LOCKED_BY_REQUEST" });
        }
        await ClientCaseSvc.update(workspace, "u1", "case-1", { title: "New title", areas: ["EMPLOYMENT"], others: [{ name: "acme ltd", role: "Opposing party" }] });
        expect((calls.caseUpdate as any[])[3]).to.include({ caseName: "New title" });
      });

      it("changes or clears the budget, even while a lawyer holds the request", async () => {
        live = { id: "req-1", status: "QUOTED" };
        await ClientCaseSvc.update(workspace, "u1", "case-1", { budget: { minMinor: 275_000, maxMinor: 275_000, feePreference: null } });
        expect((calls.caseUpdate as any[])[3]).to.deep.equal({ budgetMinMinor: 275_000, budgetMaxMinor: 275_000, budgetFeePreference: null });
        await ClientCaseSvc.update(workspace, "u1", "case-1", { budget: null });
        expect((calls.caseUpdate as any[])[3]).to.deep.equal({ budgetMinMinor: null, budgetMaxMinor: null, budgetFeePreference: null });
      });

      it("keeps a case with an open request inside the UK", async () => {
        live = { id: "req-1", status: "ROUTED" };
        expect(await errorOf(ClientCaseSvc.update(workspace, "u1", "case-1", { ukJurisdiction: null }))).to.deep.equal({ status: 409, code: "CASE_LOCKED_BY_REQUEST" });
        await ClientCaseSvc.update(workspace, "u1", "case-1", { areas: ["FAMILY"] });
        expect((calls.caseUpdate as any[])[3]).to.deep.equal({ caseAreas: ["FAMILY"] });
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
    const valid = { title: "Holiday refund", areas: ["CONSUMER"], ukJurisdiction: "Scotland" };

    it("needs the part of the UK, or null for outside it", () => {
      expect(createClientCaseSchema.validate(valid).error).to.equal(undefined);
      expect(createClientCaseSchema.validate({ ...valid, ukJurisdiction: null }).error).to.equal(undefined);
      expect(createClientCaseSchema.validate({ title: "x", areas: ["CONSUMER"] }).error).to.not.equal(undefined);
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
      expect(updateClientCaseSchema.validate({ areas: [] }).error).to.not.equal(undefined);
      expect(updateClientCaseSchema.validate({ areas: ["FAMILY"], area: "FAMILY" }).error).to.not.equal(undefined);
    });

    it("takes up to 5 documents with a message", () => {
      const ids = (n: number) => Array.from({ length: n }, (_, i) => `d${i}`);
      expect(sendClientMessageSchema.validate({ text: "Hi" }).error).to.equal(undefined);
      expect(sendClientMessageSchema.validate({ text: "Hi", documentIds: ids(5) }).error).to.equal(undefined);
      expect(sendClientMessageSchema.validate({ text: "Hi", documentIds: ids(6) }).error).to.not.equal(undefined);
      expect(sendClientMessageSchema.validate({ text: "Hi", documentIds: [""] }).error).to.not.equal(undefined);
    });

    it("takes one or more areas, each once, or the older single area, but not both and not none", () => {
      expect(createClientCaseSchema.validate({ ...valid, areas: ["CONSUMER", "FAMILY"] }).error).to.equal(undefined);
      const { areas: _areas, ...withoutAreas } = valid;
      expect(createClientCaseSchema.validate({ ...withoutAreas, area: "CONSUMER" }).error).to.equal(undefined);
      expect(createClientCaseSchema.validate(withoutAreas).error).to.not.equal(undefined);
      expect(createClientCaseSchema.validate({ ...valid, area: "CONSUMER" }).error).to.not.equal(undefined);
      expect(createClientCaseSchema.validate({ ...valid, areas: [] }).error).to.not.equal(undefined);
      expect(createClientCaseSchema.validate({ ...valid, areas: ["FAMILY", "FAMILY"] }).error).to.not.equal(undefined);
    });
  });

  it("answers the removed case payment routes with 410 CASES_ARE_FREE", async () => {
    let caught: any;
    try {
      await ClientCaseCtrl.casePaymentGone({} as Request, {} as any);
    } catch (err) {
      caught = err;
    }
    expect(caught).to.include({ statusCode: 410, code: "CASES_ARE_FREE" });
  });

  it("serves exactly these routes", () => {
    expect(listRoutes(clientRoute).map((r) => `${r.method} ${r.path}`)).to.deep.equal([
      "GET /pricing",
      "POST /payments/top-up/quote",
      "POST /payments/case/quote",
      "POST /payments/case",
      "GET /payments/:paymentId",
      "GET /limits",
      "GET /case-areas",
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
      "DELETE /cases/:caseId/documents/:documentId",
      "GET /cases/:caseId/documents/:documentId/url",
      "POST /cases/:caseId/documents/:documentId/retry",
      "GET /cases/:caseId/overview",
      "POST /cases/:caseId/overview/generate",
      "GET /cases/:caseId/intake",
      "POST /cases/:caseId/intake/refresh",
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
