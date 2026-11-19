/** The KR Library: statutes and court decisions from law.go.kr through the Korean Law MCP. The
 * parsers are checked against real answers (test/fixtures/kr-law); the provider runs against the
 * dev DB with the MCP stubbed, using made-up ids (9999xxxx) that it removes afterwards. */
import fs from "fs";
import path from "path";
import { expect } from "chai";
import { describe, it, after, beforeEach, afterEach } from "mocha";
import prisma from "../src/lib/prisma";
import * as KoreanLawMcp from "../src/utils/korean-law-mcp";
import {
  cleanBatchArticles,
  parseDecisionSearch,
  parseDecisionText,
  parseLawSearch,
  parseLawToc,
} from "../src/legal/law-source/kr/kr-law-parsers";
import { getLawSourceProvider } from "../src/legal/law-source/law-source.registry";
import { lawBrowseSchema, lawSearchSchema } from "../src/validation/law.validation";

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, "fixtures", "kr-law", name), "utf8");

describe("KR Library", () => {
  describe("reading the Korean Law MCP's answers", () => {
    it("reads statutes from a name search", () => {
      const hits = parseLawSearch(fixture("search-law.txt"));
      expect(hits.map((h) => h.title)).to.deep.equal(["근로기준법", "근로기준법 시행령", "근로기준법 시행규칙"]);
      expect(hits[0]).to.include({ mst: "285279", lawId: "001872", kind: "법률", status: "현행", promulgatedOn: "20260407", effectiveOn: "20261008" });
    });

    it("reads decisions from a search, with no court where law.go.kr says N/A", () => {
      const { total, hits } = parseDecisionSearch(fixture("search-decisions.txt"));
      expect(total).to.equal(408);
      expect(hits[0]).to.deep.equal({ id: "616245", title: "부당해고구제재심판정취소", caseNumber: "2023두54914", court: "대법원", decidedOn: "20260129", decisionType: "판결" });
      expect(hits[1]!.court).to.equal(null);
    });

    it("reads no decisions from a NOT_FOUND answer", () => {
      expect(parseDecisionSearch(fixture("search-decisions-not-found.txt"))).to.deep.equal({ total: 0, hits: [] });
    });

    it("splits a decision into its sections", () => {
      const d = parseDecisionText(fixture("decision-text.txt"));
      expect(d).to.include({ title: "손해배상(기)", caseNumber: "2026다202771", court: "대법원", decidedOn: "20260813", caseKind: "민사", decisionType: "판결" });
      expect(d.issues).to.have.length(2);
      expect(d.holdings).to.match(/^\[1\] 민사소송법 제215조/);
      expect(d.referencedProvisions).to.deep.equal(["민사소송법 제215조 제2항"]);
      expect(d.referencedCases).to.have.length(3);
      expect(d.order).to.match(/^원심판결 중 .*부담한다\.$/);
      expect(d.fullText).to.match(/^【원고, 상고인 겸 피상고인】/);
      expect(d.fullText).to.not.include("전문:");
    });

    it("reads a statute's articles from its table of contents", () => {
      const toc = parseLawToc(fixture("law-toc.txt"));
      expect(toc).to.include({ title: "근로기준법", promulgatedOn: "20260407", effectiveOn: "20261008" });
      expect(toc.articles).to.have.length(133);
      expect(toc.articles[0]).to.deep.equal({ jo: "제1조", heading: "목적" });
      expect(toc.articles.map((a) => a.jo)).to.include("제100조의2");
    });

    it("keeps articles' text without the law's name or a repeated heading", () => {
      const text = cleanBatchArticles(fixture("batch-articles.txt"), "근로기준법");
      expect(text.startsWith("제1조 목적\n이 법은")).to.equal(true);
      expect(text).to.include("제2조(정의)");
      expect(text).to.not.include("제2조 정의\n");
    });
  });

  describe("on the KR site", () => {
    const provider = getLawSourceProvider("KR");

    it("has its own source, categories and courts", () => {
      expect(provider.tenantCode).to.equal("KR");
      expect(provider.parseCategory("kr-case-law")).to.equal("JURISPRUDENCE");
      expect(provider.parseCategory("kr-legislation")).to.equal("REPUBLIC_ACT");
      expect(() => provider.parseCategory("uk-case-law")).to.throw();
      expect(lawSearchSchema(provider).validate({ category: "kr-case-law", q: "부당해고", court: "대법원,서울고등법원" }).error).to.equal(undefined);
      expect(lawBrowseSchema(provider).validate({ category: "kr-case-law", court: "고등법원" }).error).to.not.equal(undefined);
    });

    it("has no browse for statutes", async () => {
      try {
        await provider.browse({ category: "REPUBLIC_ACT", facets: {}, limit: 20 });
        expect.fail("should refuse");
      } catch (e: any) {
        expect(e.statusCode).to.equal(400);
      }
    });
  });

  describe("searching, browsing and opening through the MCP", () => {
    const provider = getLawSourceProvider("KR");
    const original = KoreanLawMcp.callKoreanLawTool;
    const calls: { name: string; args: any }[] = [];
    let answers: Record<string, (args: any) => string> = {};
    // Made-up ids, so nothing real is touched: decisions 9999xxxx, the statute MST 99990285279.
    const testIds = (text: string) => text.replace(/\[(\d{6})\]/g, "[9999$1]");
    const runId = `krlib-${Date.now()}`;

    beforeEach(() => {
      calls.length = 0;
      (KoreanLawMcp as any).callKoreanLawTool = async (name: string, args: any) => {
        calls.push({ name, args });
        const answer = answers[name];
        if (!answer) throw new KoreanLawMcp.KoreanLawMcpUnavailableError("no answer stubbed");
        return answer(args);
      };
    });
    afterEach(() => {
      (KoreanLawMcp as any).callKoreanLawTool = original;
    });
    after(async () => {
      const rows = await prisma.law.findMany({ where: { jurisSourceId: { startsWith: "kr:" } }, select: { id: true, jurisSourceId: true } });
      const ours = rows.filter((r) => /^kr:(?:prec:9999|law:9999)/.test(r.jurisSourceId));
      await prisma.lawBrowsePage.deleteMany({ where: { jurisIds: { hasSome: ours.map((r) => r.jurisSourceId) } } });
      await prisma.law.deleteMany({ where: { id: { in: ours.map((r) => r.id) } } });
    });

    it("searches decisions once, then serves the page from the DB", async () => {
      answers = { search_decisions: () => testIds(fixture("search-decisions.txt")) };
      const first = await provider.search({ category: "JURISPRUDENCE", q: runId, limit: 3 });
      expect(first.items.map((i) => i.case_number)).to.deep.equal(["2023두54914", "서울행정법원-2025-구합-53785", "2025두33276"]);
      expect(first.items[0]).to.include({ division: "대법원", case_title: "부당해고구제재심판정취소" });
      expect(first.cursor).to.be.a("string");
      expect(calls).to.have.length(1);
      expect(calls[0]!.args).to.deep.include({ domain: "precedent", query: runId, display: 3, page: 1 });

      const again = await provider.search({ category: "JURISPRUDENCE", q: runId, limit: 3 });
      expect(again.items.map((i) => i.id)).to.deep.equal(first.items.map((i) => i.id));
      expect(calls).to.have.length(1);
    });

    it("browses newest first, one request per chosen court", async () => {
      answers = { search_decisions: () => testIds(fixture("search-decisions.txt")) };
      // A fresh filter each run: the court list is fixed, so a run id can't go in the key.
      const limit = 4 + (Date.now() % 10);
      await provider.browse({ category: "JURISPRUDENCE", facets: { courts: ["대법원", "서울고등법원"] }, limit });
      expect(calls.map((c) => c.args.options?.court).sort()).to.deep.equal(["대법원", "서울고등법원"]);
      expect(calls.every((c) => c.args.sort === "ddes" && c.args.query === "")).to.equal(true);
    });

    it("opens a decision with its sections and full text", async () => {
      answers = {
        search_decisions: () => testIds(fixture("search-decisions.txt")),
        get_decision_text: () => fixture("decision-text.txt"),
      };
      const found = await provider.search({ category: "JURISPRUDENCE", q: `${runId}-open`, limit: 3 });
      const doc = await provider.getDocument({ category: "JURISPRUDENCE", id: found.items[0]!.id });
      expect(calls.at(-1)).to.deep.include({ name: "get_decision_text" });
      expect(calls.at(-1)!.args).to.deep.equal({ domain: "precedent", id: "9999616245", full: true });
      expect(doc.detail.fetched).to.equal(true);
      expect(doc.detail.legal_issues).to.have.length(2);
      expect(doc.item.disposition).to.match(/^원심판결 중/);
      expect(doc.item.full_text).to.match(/^【원고/);
      expect(doc.item.pdf_url).to.equal(null);
      expect(doc.item.source_url).to.equal("https://www.law.go.kr/LSW/precInfoP.do?precSeq=9999616245");
    });

    it("opens a statute with every article's text, 50 articles a request", async () => {
      answers = {
        search_law: () => fixture("search-law.txt").replace("MST: 285279", "MST: 99990285279"),
        get_law_text: () => fixture("law-toc.txt"),
        execute_tool: () => fixture("batch-articles.txt"),
      };
      const found = await provider.search({ category: "REPUBLIC_ACT", q: `${runId}-law`, limit: 3 });
      const law = found.items.find((i) => i.title === "근로기준법")!;
      expect(law).to.include({ ra_number: "법률", summary: "공포 2026.04.07 · 시행 2026.10.08" });
      const doc = await provider.getDocument({ category: "REPUBLIC_ACT", id: law.id });
      const batches = calls.filter((c) => c.name === "execute_tool");
      expect(batches.map((b) => b.args.params.articles.length)).to.deep.equal([50, 50, 33]);
      expect(batches[0]!.args.params.mst).to.equal("99990285279");
      expect(doc.item.full_text).to.include("제1조 목적");
      expect(doc.detail.date_enacted).to.equal("2026.10.08");
    });

    it("serves stored decisions when the MCP is down, and 502 when nothing matches", async () => {
      answers = {};
      const stored = await provider.search({ category: "JURISPRUDENCE", q: "2023두54914", limit: 5 }).catch((e) => e);
      // Matches the decisions stored above (or real ones with that number), never another site's.
      if (!(stored instanceof Error)) expect(stored.items.every((i: any) => i.case_number?.includes("2023두54914"))).to.equal(true);
      try {
        await provider.search({ category: "JURISPRUDENCE", q: `${runId}-nothing-stored`, limit: 5 });
        expect.fail("should 502");
      } catch (e: any) {
        expect(e.statusCode).to.equal(502);
      }
    });
  });
});
