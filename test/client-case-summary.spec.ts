/** The client's Case summary (ilovelawyer-client#137): what goes in it, what never does, and that the
 * PDF draws Korean as well as English. Pure — no database, no S3. */
import { expect } from "chai";
import { describe, it } from "mocha";
import fs from "fs";
import { PDFParse } from "pdf-parse";
import { buildCaseSummaryDocument, caseSummaryFilename, type CaseSummaryInput } from "../src/utils/client-case-summary-document";
import { renderCaseSummaryToPdf, SUMMARY_FONT_BOLD, SUMMARY_FONT_REGULAR, SUMMARY_LOGO } from "../src/utils/client-case-summary-pdf-renderer";
import type { CaseIntake, IntakeSource } from "../src/types/client-intake";

const CHAT: IntakeSource = { kind: "CLIENT", messageId: "m1", documentId: null, documentName: null, page: null };
const DOC: IntakeSource = { kind: "DOCUMENT", messageId: null, documentId: "d1", documentName: "tenancy.pdf", page: 2 };
const DETAILS: IntakeSource = { kind: "CASE_DETAILS", messageId: null, documentId: null, documentName: null, page: null };

function intake(overrides: Partial<CaseIntake> = {}): CaseIntake {
  return {
    generatedAt: "2026-11-18T09:30:00.000Z",
    status: "READY",
    updates: { allowed: true, leftToday: 3 },
    summary: "AI SUMMARY PARAGRAPH",
    people: [{ id: "p1", name: "Acme Lettings", role: "the landlord's agent", text: "the landlord's agent", sources: [DETAILS] }],
    timeline: [
      { id: "t1", date: "2026-03-12", datePrecision: "DAY", text: "Moved out and returned the keys", sources: [CHAT] },
      { id: "t2", date: "2026-04-01", datePrecision: "MONTH", text: "Asked for the deposit back", sources: [CHAT] },
      { id: "t3", date: null, datePrecision: "UNKNOWN", text: "Agent stopped replying", sources: [CHAT] },
    ],
    facts: [{ id: "f1", text: "The deposit was £1,200", sources: [DOC] }],
    goals: [{ id: "g1", text: "Get the full deposit back", sources: [CHAT] }],
    concerns: [{ id: "c1", text: "Worried about legal costs", sources: [CHAT] }],
    questionsForLawyer: [{ id: "q1", text: "Was the deposit protected?", sources: [CHAT] }],
    deadlines: [{ id: "d1", date: "2026-12-01", text: "The agent said to reply by 1 December", sources: [CHAT, DOC] }],
    missing: [{ id: "x1", question: "When was the deposit paid?", why: "A lawyer will ask when it was protected." }],
    conflicts: [{ id: "k1", description: "The rent is £950 in the chat but £995 in the tenancy", sources: [CHAT, DOC] }],
    completeness: { ready: false, criteria: [{ key: "dates", label: "Key dates", met: true }] },
    ...overrides,
  };
}

function input(overrides: Partial<CaseSummaryInput> = {}): CaseSummaryInput {
  return {
    title: "Deposit not returned",
    areas: ["Housing"],
    ukJurisdiction: "England and Wales",
    outsideUk: false,
    where: "Leeds",
    notes: "My landlord kept my deposit.",
    documentNames: ["tenancy.pdf", "photos.zip"],
    intake: intake(),
    tenantCode: "UK",
    lang: "en",
    ...overrides,
  };
}

async function textOf(pdf: Buffer): Promise<string> {
  const parser = new PDFParse({ data: pdf });
  try {
    return (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
}

describe("Client case summary — contents", () => {
  it("has the case details, the client's words and every intake section, in order", () => {
    const doc = buildCaseSummaryDocument(input());
    expect(doc.kicker).to.equal("Case summary");
    expect(doc.details).to.deep.equal([
      { label: "Type of issue", value: "Housing" },
      { label: "Part of the UK", value: "England and Wales" },
      { label: "Where", value: "Leeds" },
    ]);
    expect(doc.description).to.deep.equal({ label: "In your words", text: "My landlord kept my deposit." });
    expect(doc.sections.map((s) => [s.kind, s.title])).to.deep.equal([
      ["callout", "Deadlines, as you stated them"],
      ["list", "People and organisations involved"],
      ["dated", "Timeline"],
      ["list", "Facts"],
      ["list", "What you want"],
      ["list", "Your concerns"],
      ["list", "Questions for a lawyer"],
      ["list", "Information still missing"],
      ["list", "Accounts that don't match"],
      ["list", "Documents you uploaded"],
    ]);
    expect(doc.pageLabel).to.equal("Page {n} of {total}");
    expect(doc.asOf).to.equal("As of 18 November 2026");
    expect(doc.disclaimer).to.equal("Prepared from the information you gave us. It isn't legal advice.");
  });

  it("includes the intake's summary, labelled AI-written as the Overview labels it", () => {
    expect(buildCaseSummaryDocument(input()).aiSummary).to.deep.equal({
      label: "Summary",
      tag: "AI-written · check it against what you said",
      text: "AI SUMMARY PARAGRAPH",
    });
    expect(buildCaseSummaryDocument(input({ lang: "ko" })).aiSummary!.tag).to.equal("AI 작성 · 말씀하신 내용과 맞는지 확인하세요");
    expect(buildCaseSummaryDocument(input({ intake: intake({ summary: null }) })).aiSummary).to.equal(null);
    expect(buildCaseSummaryDocument(input({ intake: intake({ summary: "   " }) })).aiSummary).to.equal(null);
  });

  it("leaves out the readiness criteria", () => {
    expect(JSON.stringify(buildCaseSummaryDocument(input()))).to.not.include("Key dates");
  });

  it("prints each deadline as stated, with its date only when given, and its sources", () => {
    const deadlines = buildCaseSummaryDocument(input()).sections.find((s) => s.title === "Deadlines, as you stated them")!;
    expect(deadlines.items).to.deep.equal([
      { text: "The agent said to reply by 1 December", date: "1 December 2026", source: "Source: what you said in the chat; tenancy.pdf, page 2" },
    ]);
    const undated = buildCaseSummaryDocument(input({ intake: intake({ deadlines: [{ id: "d", date: null, text: "Within 14 days", sources: [CHAT] }] }) }));
    expect(undated.sections.find((s) => s.title.startsWith("Deadlines"))!.items[0]!.date).to.equal("Date not given");
  });

  it("dates timeline events at the precision they were given", () => {
    const timeline = buildCaseSummaryDocument(input()).sections.find((s) => s.title === "Timeline")!;
    expect(timeline.items.map((i) => i.date)).to.deep.equal(["12 March 2026", "April 2026", "Date not given"]);
  });

  it("puts why a missing piece matters under it", () => {
    const missing = buildCaseSummaryDocument(input()).sections.find((s) => s.title === "Information still missing")!;
    expect(missing.items).to.deep.equal([{ text: "When was the deposit paid?", note: "A lawyer will ask when it was protected." }]);
  });

  it("lists uploaded documents by name only", () => {
    const docs = buildCaseSummaryDocument(input()).sections.find((s) => s.title === "Documents you uploaded")!;
    expect(docs.items).to.deep.equal([{ text: "tenancy.pdf" }, { text: "photos.zip" }]);
  });

  it("drops empty sections and an empty description", () => {
    const doc = buildCaseSummaryDocument(
      input({ notes: "  ", documentNames: [], intake: intake({ concerns: [], conflicts: [], missing: [], people: [] }) }),
    );
    expect(doc.description).to.equal(null);
    expect(doc.sections.map((s) => s.title)).to.not.include.members(["Your concerns", "Accounts that don't match", "Documents you uploaded"]);
  });

  it("asks which part of the UK only on the UK site, and says when it's outside or unknown", () => {
    expect(buildCaseSummaryDocument(input({ ukJurisdiction: null, outsideUk: true })).details[1]).to.deep.equal({ label: "Part of the UK", value: "Outside the UK" });
    expect(buildCaseSummaryDocument(input({ ukJurisdiction: null })).details[1]).to.deep.equal({ label: "Part of the UK", value: "Not known yet" });
    const kr = buildCaseSummaryDocument(input({ tenantCode: "KR", ukJurisdiction: null, where: "서울" }));
    expect(kr.details.map((d) => d.label)).to.deep.equal(["Type of issue", "Where"]);
  });

  it("speaks Korean when asked, on the site's own calendar", () => {
    const doc = buildCaseSummaryDocument(input({ lang: "ko", tenantCode: "KR", intake: intake({ generatedAt: "2026-11-18T20:00:00.000Z" }) }));
    expect(doc.kicker).to.equal("사건 요약");
    // 20:00 UTC on the 18th is already the 19th in Seoul.
    expect(doc.asOf).to.equal("2026년 11월 19일 기준");
    expect(doc.disclaimer).to.equal("제공해 주신 정보로 작성했습니다. 법률 자문이 아닙니다.");
    expect(doc.sections.find((s) => s.title === "직접 말씀하신 기한")!.items[0]!.source).to.equal("출처: 채팅에서 말씀하신 내용; tenancy.pdf, 2쪽");
  });
});

describe("Client case summary — filename", () => {
  const now = new Date("2026-11-20T10:00:00.000Z");

  it("slugs the title and dates it on the site's calendar", () => {
    expect(caseSummaryFilename("Landlord won't return my deposit!", now, "UK")).to.equal("case-summary-landlord-won-t-return-my-deposit-2026-11-20.pdf");
    expect(caseSummaryFilename("x", new Date("2026-11-20T23:30:00.000Z"), "KR")).to.equal("case-summary-x-2026-11-21.pdf");
  });

  it("keeps Korean letters and strips path characters", () => {
    expect(caseSummaryFilename("전세 보증금 반환", now, "KR")).to.equal("case-summary-전세-보증금-반환-2026-11-20.pdf");
    expect(caseSummaryFilename("../a/b:c*?\"<>|", now, "UK")).to.equal("case-summary-a-b-c-2026-11-20.pdf");
    expect(caseSummaryFilename(" *** ", now, "UK")).to.equal("case-summary-case-2026-11-20.pdf");
  });
});

describe("Client case summary — PDF", function () {
  this.timeout(20_000);

  it("ships its fonts and the logo", () => {
    for (const asset of [SUMMARY_FONT_REGULAR, SUMMARY_FONT_BOLD, SUMMARY_LOGO]) expect(fs.existsSync(asset), asset).to.equal(true);
  });

  it("numbers its pages in the reader's language", async () => {
    expect(await textOf(await renderCaseSummaryToPdf(buildCaseSummaryDocument(input())))).to.match(/Page 1 of \d/);
    const ko = await textOf(await renderCaseSummaryToPdf(buildCaseSummaryDocument(input({ lang: "ko", tenantCode: "KR" }))));
    expect(ko).to.match(/\d쪽 중 1쪽/);
  });

  it("renders an English summary with its sections and the disclaimer", async () => {
    const pdf = await renderCaseSummaryToPdf(buildCaseSummaryDocument(input()));
    expect(pdf.subarray(0, 5).toString()).to.equal("%PDF-");
    const text = await textOf(pdf);
    for (const expected of ["Deposit not returned", "AI-written · check it against what you said", "AI SUMMARY PARAGRAPH", "Questions for a lawyer", "The deposit was £1,200", "It isn't legal advice."]) {
      expect(text).to.include(expected);
    }
  });

  it("draws Korean text", async () => {
    const pdf = await renderCaseSummaryToPdf(
      buildCaseSummaryDocument(
        input({
          lang: "ko",
          tenantCode: "KR",
          title: "전세 보증금 반환",
          ukJurisdiction: null,
          notes: "집주인이 보증금을 돌려주지 않습니다.",
          intake: intake({ goals: [{ id: "g", text: "보증금 전액을 돌려받고 싶습니다", sources: [CHAT] }] }),
        }),
      ),
    );
    const text = await textOf(pdf);
    for (const expected of ["전세 보증금 반환", "집주인이 보증금을 돌려주지 않습니다.", "보증금 전액을 돌려받고 싶습니다", "법률 자문이 아닙니다."]) {
      expect(text).to.include(expected);
    }
  });

  it("runs a long summary onto more pages without losing items", async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ id: `f${i}`, text: `Fact number ${i} with enough words to wrap across the line at least once or twice`, sources: [CHAT] }));
    const text = await textOf(await renderCaseSummaryToPdf(buildCaseSummaryDocument(input({ intake: intake({ facts: many }) }))));
    expect(text).to.include("Fact number 0 ");
    expect(text).to.include("Fact number 119 ");
  });
});
