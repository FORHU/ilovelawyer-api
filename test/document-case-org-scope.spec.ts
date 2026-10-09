/** #373: defence in depth for a document already attached to a case outside its own organization
 * (e.g. planted before #371 closed the upload path, or by any future path that forgets the check).
 *
 * Every reader of a case's documents filters by caseId alone — DocumentRepo.listAllByCase (the
 * snapshot, findings, refresh, mind map, outlook, reconstruction, graph view) and chat retrieval
 * via DocumentChunkSvc.relevantChunksForCase / DocumentChunkRepo.findRelevantByCase. Each now also
 * requires the document's organizationId to match the case's, so a mis-attached document is never
 * read as part of the case even though its caseId still points at it.
 *
 * A case with no organization (Case.organizationId null — a creator-owned, pre-org case) skips the
 * org filter entirely, same as #371's assertCanUploadToCase: there's no org to compare against,
 * and its documents are reached by caseId alone just as before.
 *
 * No live Postgres: prisma is monkeypatched. The raw-SQL chunk query is checked by capturing the
 * query text $queryRaw was called with, not by running it.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import prisma from "../src/lib/prisma";
import DocumentRepo from "../src/repositories/document.repository";
import DocumentChunkRepo from "../src/repositories/document-chunk.repository";
import DocumentChunkSvc from "../src/services/document-chunk.service";

const restore: (() => void)[] = [];
function stub(target: any, key: string, value: unknown) {
  const original = target[key];
  restore.push(() => {
    target[key] = original;
  });
  target[key] = value;
}

const ORG = "org-1";
const OTHER_ORG = "org-2";

describe("#373 — case document reads require the document's org to match the case's", () => {
  afterEach(() => {
    while (restore.length) restore.pop()!();
  });

  describe("DocumentRepo.listAllByCase", () => {
    it("filters by the case's organization, not caseId alone", async () => {
      let where: any;
      stub(prisma.case, "findUnique", async () => ({ organizationId: ORG }));
      stub(prisma.document, "findMany", async (args: any) => ((where = args.where), []));

      await DocumentRepo.listAllByCase("case-1");

      expect(where).to.deep.equal({ caseId: "case-1", organizationId: ORG });
    });

    it("a case with no organization skips the org filter", async () => {
      let where: any;
      stub(prisma.case, "findUnique", async () => ({ organizationId: null }));
      stub(prisma.document, "findMany", async (args: any) => ((where = args.where), []));

      await DocumentRepo.listAllByCase("case-1");

      expect(where).to.deep.equal({ caseId: "case-1" });
    });

    it("a case that no longer exists skips the org filter rather than throwing", async () => {
      let where: any;
      stub(prisma.case, "findUnique", async () => null);
      stub(prisma.document, "findMany", async (args: any) => ((where = args.where), []));

      const result = await DocumentRepo.listAllByCase("case-gone");

      expect(where).to.deep.equal({ caseId: "case-gone" });
      expect(result).to.deep.equal([]);
    });
  });

  describe("DocumentChunkSvc.relevantChunksForCase", () => {
    it("the auto-selected document list is scoped to the case's organization", async () => {
      let where: any;
      stub(prisma.case, "findUnique", async () => ({ organizationId: ORG }));
      stub(prisma.document, "findMany", async (args: any) => ((where = args.where), []));

      await DocumentChunkSvc.relevantChunksForCase("case-1", "some query");

      expect(where).to.deep.equal({ caseId: "case-1", ragStatus: "READY", status: "ACTIVE", organizationId: ORG });
    });

    it("a case with no organization skips the org filter", async () => {
      let where: any;
      stub(prisma.case, "findUnique", async () => ({ organizationId: null }));
      stub(prisma.document, "findMany", async (args: any) => ((where = args.where), []));

      await DocumentChunkSvc.relevantChunksForCase("case-1", "some query");

      expect(where).to.deep.equal({ caseId: "case-1", ragStatus: "READY", status: "ACTIVE" });
    });

    it("a consultation scope is untouched — no case lookup, no org filter", async () => {
      let where: any;
      let caseLookups = 0;
      stub(prisma.case, "findUnique", async () => {
        caseLookups++;
        return { organizationId: ORG };
      });
      stub(prisma.document, "findMany", async (args: any) => ((where = args.where), []));

      await DocumentChunkSvc.relevantChunksForConsultation("consultation-1", "some query");

      expect(caseLookups).to.equal(0);
      expect(where).to.deep.equal({ consultationId: "consultation-1", ragStatus: "READY", status: "ACTIVE" });
    });
  });

  describe("DocumentChunkRepo.findRelevantByCase — the raw-SQL chunk ranking", () => {
    it("joins to Case and only matches a document whose org equals the case's (or the case has none)", async () => {
      let sql = "";
      stub(prisma, "$queryRaw", (strings: TemplateStringsArray) => {
        sql = strings.join("?");
        return Promise.resolve([]);
      });

      await DocumentChunkRepo.findRelevantByCase("case-1", new Array(1536).fill(0));

      expect(sql).to.include('INNER JOIN "Case"');
      expect(sql).to.include('d."organizationId" = cs."organizationId"');
      expect(sql).to.include('cs."organizationId" IS NULL');
    });
  });
});
