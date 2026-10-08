/** #346: every path that reached a case by organization alone now asks CaseAccess too, so a
 * confidential case doesn't leak through any of them to someone it's walled off from (D4: not
 * in any listing, every direct read 404s).
 *
 * The rule itself is covered by case-confidential-access.spec.ts; here CaseAccess is stubbed to
 * refuse "walled" and allow "allowed", and each path is checked to consult it — with the acting
 * user — before handing anything back. No live Postgres: repos and prisma are monkeypatched.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import prisma from "../src/lib/prisma";
import CaseAccess from "../src/utils/case-access";
import HttpError from "../src/utils/http-error";
import CaseSvc from "../src/services/case.service";
import CaseRepo from "../src/repositories/case.repository";
import DocumentSvc from "../src/services/document.service";
import DocumentRepo from "../src/repositories/document.repository";
import TranscriptionSvc from "../src/services/transcription.service";
import TranscriptionRepo from "../src/repositories/transcription.repository";
import ChatSvc from "../src/services/chat.service";
import ChatRepo from "../src/repositories/chat.repository";
import ParticipantRepo from "../src/repositories/participant.repository";
import CaseCopyRepo from "../src/repositories/case-copy.repository";

const WALLED = "walled";
const ALLOWED = "allowed";

async function rejection(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to be refused");
}

describe("#346 — confidential cases don't leak", () => {
  /** Stubs on module objects, restored after each test. */
  const restore: (() => void)[] = [];
  function stub(target: any, key: string, value: unknown) {
    const original = target[key];
    restore.push(() => {
      target[key] = original;
    });
    target[key] = value;
  }

  let checks: { caseId: string; userId: string }[];

  beforeEach(() => {
    checks = [];
    stub(CaseAccess, "loadAccessibleCase", async (caseId: string, userId: string) => {
      checks.push({ caseId, userId });
      if (userId === WALLED) throw new HttpError("Case not found", 404);
      return { id: caseId, organizationId: "org-1" };
    });
  });

  afterEach(() => {
    while (restore.length) restore.pop()!();
  });

  describe("#346 — the case list and case page", () => {
    it("CaseRepo.list filters by CaseAccess.visibleWhere for the requesting user", async () => {
      const wheres: any[] = [];
      stub(prisma.case, "count", (args: any) => (wheres.push(args.where), Promise.resolve(0)));
      stub(prisma.case, "findMany", (args: any) => (wheres.push(args.where), Promise.resolve([])));
      stub(prisma, "$transaction", (ops: Promise<unknown>[]) => Promise.all(ops));

      await CaseRepo.list("org-1", "user-1", 1, 20);

      expect(wheres).to.have.length(2);
      for (const where of wheres) {
        expect(where.organizationId).to.equal("org-1");
        expect(where.AND).to.deep.include(CaseAccess.visibleWhere("user-1"));
      }
    });

    it("CaseSvc.getById 404s for a walled user before reading the case", async () => {
      let read = false;
      stub(CaseRepo, "findById", async () => ((read = true), { id: "case-1" }));
      const err = await rejection(CaseSvc.getById("case-1", "org-1", WALLED));
      expect(err.statusCode).to.equal(404);
      expect(read).to.equal(false);
    });

    it("CaseSvc.getById checks as the acting user and still scopes to the organization", async () => {
      stub(CaseRepo, "findById", async (id: string, organizationId: string) => (organizationId === "org-1" ? { id } : null));
      stub(CaseRepo, "withCopyContext", async (rows: unknown[]) => rows);
      await CaseSvc.getById("case-1", "org-1", ALLOWED);
      expect(checks).to.deep.equal([{ caseId: "case-1", userId: ALLOWED }]);
      const err = await rejection(CaseSvc.getById("case-1", "org-2", ALLOWED));
      expect(err.statusCode).to.equal(404);
    });

    it("CaseSvc.markOpened 404s for a walled user without stamping the view", async () => {
      let stamped = false;
      stub(CaseRepo, "findById", async () => ({ id: "case-1" }));
      stub(CaseRepo, "markOpened", async () => {
        stamped = true;
      });
      const err = await rejection(CaseSvc.markOpened("case-1", "org-1", WALLED));
      expect(err.statusCode).to.equal(404);
      expect(stamped).to.equal(false);
    });
  });

  describe("#346 — documents", () => {
    const caseDoc = { id: "doc-1", caseId: "case-1", status: "ACTIVE", file: null };
    const looseDoc = { id: "doc-2", caseId: null, status: "ACTIVE", file: null };

    it("the org-wide list leaves out documents of cases the user can't open", async () => {
      let where: any;
      stub(prisma.document, "findMany", async (args: any) => ((where = args.where), []));
      await DocumentRepo.list("org-1", "ACTIVE", "user-1");
      expect(where.organizationId).to.equal("org-1");
      expect(where.OR).to.deep.equal([{ caseId: null }, { case: CaseAccess.visibleWhere("user-1") }]);
    });

    it("listByCase 404s for a walled user before listing", async () => {
      let listed = false;
      stub(DocumentRepo, "listByCase", async () => ((listed = true), []));
      const err = await rejection(DocumentSvc.listByCase("org-1", "case-1", WALLED));
      expect(err.statusCode).to.equal(404);
      expect(listed).to.equal(false);
    });

    it("getById and the text preview 404 for a walled user on a case document", async () => {
      stub(DocumentRepo, "findById", async () => caseDoc);
      expect((await rejection(DocumentSvc.getById("doc-1", "org-1", WALLED))).statusCode).to.equal(404);
      expect((await rejection(DocumentSvc.getTextPreview("doc-1", "org-1", WALLED))).statusCode).to.equal(404);
    });

    it("a document with no case needs no case check", async () => {
      stub(DocumentRepo, "findById", async () => looseDoc);
      await DocumentSvc.getById("doc-2", "org-1", WALLED);
      expect(checks).to.deep.equal([]);
    });
  });

  describe("#346 — transcriptions", () => {
    const caseItem = { id: "tr-1", caseId: "case-1", audioFile: null };

    it("the org-wide list leaves out transcriptions of cases the user can't open", async () => {
      let where: any;
      stub(prisma.transcription, "findMany", async (args: any) => ((where = args.where), []));
      await TranscriptionRepo.findAllByUser("org-1", "user-1");
      expect(where.organizationId).to.equal("org-1");
      expect(where.OR).to.deep.equal([{ caseId: null }, { case: CaseAccess.visibleWhere("user-1") }]);
    });

    it("listByCase 404s for a walled user before listing", async () => {
      let listed = false;
      stub(TranscriptionRepo, "findAllByCase", async () => ((listed = true), []));
      const err = await rejection(TranscriptionSvc.listByCase("org-1", "case-1", WALLED));
      expect(err.statusCode).to.equal(404);
      expect(listed).to.equal(false);
    });

    it("every by-id operation 404s for a walled user on a case transcription", async () => {
      let wrote = false;
      stub(TranscriptionRepo, "findById", async () => caseItem);
      stub(TranscriptionRepo, "update", async () => ((wrote = true), caseItem));
      stub(TranscriptionRepo, "delete", async () => ((wrote = true), caseItem));
      for (const call of [
        () => TranscriptionSvc.getById("tr-1", "org-1", WALLED),
        () => TranscriptionSvc.update("tr-1", "org-1", WALLED, { title: "x" }),
        () => TranscriptionSvc.delete("tr-1", "org-1", WALLED),
        () => TranscriptionSvc.startBatchJob("tr-1", "org-1", WALLED),
        () => TranscriptionSvc.pollJobStatus("tr-1", "org-1", WALLED),
        () => TranscriptionSvc.chunk("tr-1", "org-1", WALLED),
      ]) {
        expect((await rejection(call())).statusCode).to.equal(404);
      }
      expect(wrote).to.equal(false);
    });
  });

  describe("#346 — chat", () => {
    const consultation = { id: "c-1", userId: WALLED, organizationId: "org-1", caseId: "case-1", status: "ACTIVE" };

    it("a consultation's creator loses it once its case is confidential and walled to them", async () => {
      stub(ChatRepo, "findConsultationById", async () => consultation);
      stub(CaseAccess, "isConfidential", async () => true);
      const err = await rejection(ChatSvc.assertConsultationAccess("org-1", WALLED, "c-1"));
      expect(err.statusCode).to.equal(404);
    });

    it("an invited participant loses it too", async () => {
      stub(ChatRepo, "findConsultationById", async () => ({ ...consultation, userId: "someone-else" }));
      stub(ParticipantRepo, "exists", async () => true);
      stub(CaseAccess, "isConfidential", async () => true);
      const err = await rejection(ChatSvc.assertConsultationAccess("org-1", WALLED, "c-1"));
      expect(err.statusCode).to.equal(404);
    });

    it("on an ordinary case the creator keeps their consultation, as before", async () => {
      stub(ChatRepo, "findConsultationById", async () => consultation);
      stub(CaseAccess, "isConfidential", async () => false);
      const result = await ChatSvc.assertConsultationAccess("org-1", WALLED, "c-1");
      expect(result.id).to.equal("c-1");
    });
  });

  describe("#346 — leaving the organization", () => {
    it("never queues a portfolio copy of a confidential case", async () => {
      let where: any;
      const tx = {
        case: { findMany: async (args: any) => ((where = args.where), []) },
        caseCopy: { createMany: async () => ({}) },
      };
      await CaseCopyRepo.enqueueForCreatorIn(tx as any, {
        sourceOrganizationId: "org-1",
        sourceOrganizationName: "Firm",
        userId: "leaver",
        targetOrganizationId: "portfolio-1",
      });
      expect(where).to.include({ organizationId: "org-1", userId: "leaver", confidential: false });
    });
  });
});
