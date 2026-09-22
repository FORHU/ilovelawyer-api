import { expect } from "chai";
import { describe, it } from "mocha";
import PDFDocument from "pdfkit";
import { PDFParse } from "pdf-parse";
import { renderBriefToPdf, columnWidths, measureRowHeight } from "../src/utils/case-brief-pdf-renderer";
import type { BriefDocument } from "../src/utils/case-brief-document";

const ATTRIBUTION_HEADERS = ["Statement", "Category", "Source"];
const LONG_SOURCE = "RES-MEET-001_Minutes-of-Pre-Completion-Management-Update-Meeting.pdf";

function briefWithTable(headers: string[], rows: string[][]): BriefDocument {
  return {
    cover: {
      caseName: "Test Case",
      actionType: null,
      jurisdiction: null,
      generatedAt: new Date("2026-01-01"),
      lastRefreshedAt: null,
    },
    sections: [{ title: "Gaps & Attribution", blocks: [{ type: "table", headers, rows }] }],
  };
}

async function pagesOf(pdf: Buffer): Promise<string[]> {
  const parser = new PDFParse({ data: pdf });
  try {
    const result = await parser.getText();
    return result.pages.map((p: { text: string }) => p.text);
  } finally {
    await parser.destroy();
  }
}

function attributionRows(count: number): string[][] {
  return Array.from({ length: count }, (_, i) => [
    `Statement number ${i} about what the minutes recorded at the pre-completion meeting.`,
    "GROUNDED",
    LONG_SOURCE,
  ]);
}

describe("Case Brief PDF table layout", () => {
  it("row height is driven by the tallest cell, not just the first", () => {
    const doc = new PDFDocument();
    doc.font("Helvetica").fontSize(9);
    const widths = columnWidths(ATTRIBUTION_HEADERS, 500);
    const shortStatementLongSource = ["Short.", "GROUNDED", LONG_SOURCE];
    const wrappedSource = doc.heightOfString(LONG_SOURCE, { width: widths[2]! - 8 });

    expect(wrappedSource).to.be.greaterThan(14); // the filename really wraps in its column
    expect(measureRowHeight(doc, shortStatementLongSource, widths)).to.be.at.least(wrappedSource);
    doc.end();
  });

  it("attribution tables get a wider Statement column; other tables stay equal", () => {
    const attribution = columnWidths(ATTRIBUTION_HEADERS, 500);
    expect(attribution[0]).to.be.greaterThan(attribution[1]!);
    expect(attribution[0]).to.be.greaterThan(attribution[2]!);
    expect(attribution.reduce((a, b) => a + b, 0)).to.be.closeTo(500, 0.001);

    const other = columnWidths(["Date", "Event", "Note", "Ref"], 400);
    expect(other).to.deep.equal([100, 100, 100, 100]);
  });

  it("a long table paginates, keeps every row, and repeats the header on continuation pages", async () => {
    const pdf = await renderBriefToPdf(briefWithTable(ATTRIBUTION_HEADERS, attributionRows(40)));
    const pages = await pagesOf(pdf);
    const tablePages = pages.filter((p) => p.includes("Statement"));

    expect(tablePages.length).to.be.greaterThan(1);
    const all = pages.join("\n");
    for (const i of [0, 19, 39]) expect(all).to.include(`Statement number ${i} `);
    // No row is split across a page break: every page has as many sources as statements.
    for (const page of pages.filter((p) => p.includes("Statement number"))) {
      const statements = (page.match(/Statement number/g) ?? []).length;
      const sources = (page.match(/RES-MEET-001_/g) ?? []).length;
      expect(sources).to.equal(statements);
    }
    // Header appears once per page that holds table rows.
    const pagesWithRows = pages.filter((p) => p.includes("Statement number"));
    expect(tablePages.length).to.equal(pagesWithRows.length);
  });

  it("a short table stays on one page with no spurious extra page", async () => {
    const pdf = await renderBriefToPdf(briefWithTable(ATTRIBUTION_HEADERS, attributionRows(3)));
    const pages = await pagesOf(pdf);
    // Cover page + one section page.
    expect(pages).to.have.length(2);
  });

  it("an empty table renders just the header without crashing", async () => {
    const pdf = await renderBriefToPdf(briefWithTable(ATTRIBUTION_HEADERS, []));
    const pages = await pagesOf(pdf);
    expect(pages.join("\n")).to.include("Statement");
  });

  it("a single row taller than a page terminates and is not dropped", async () => {
    const huge = "word ".repeat(4000).trim();
    const pdf = await renderBriefToPdf(briefWithTable(["Note", "Ref"], [[huge, "x"], ["after", "y"]]));
    const all = (await pagesOf(pdf)).join("\n");
    expect(all).to.include("after");
  });

  it("a non-attribution table with wrapped cells in a later column paginates without losing rows", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => [`d${i}`, `event ${i}`, "long note ".repeat(20).trim(), `ref${i}`]);
    const pdf = await renderBriefToPdf(briefWithTable(["Date", "Event", "Note", "Ref"], rows));
    const all = (await pagesOf(pdf)).join("\n");
    expect(all).to.include("ref0");
    expect(all).to.include("ref29");
  });
});
