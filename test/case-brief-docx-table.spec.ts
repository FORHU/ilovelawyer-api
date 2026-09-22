import { expect } from "chai";
import { describe, it } from "mocha";
import JSZip from "jszip";
import { renderBriefToDocx } from "../src/utils/case-brief-docx-renderer";
import type { BriefDocument } from "../src/utils/case-brief-document";

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

/** docx is a zip of OOXML; column widths land as `w:tcW w:w="<twips-or-pct>"` on each header
 * cell's `w:tcPr`. Pull those out in document order to check the ratios pdfkit's ticket bug also
 * needed — no docx-parsing library in this repo already, so this reads the XML directly. */
async function headerCellWidths(docxBuffer: Buffer): Promise<number[]> {
  const zip = await JSZip.loadAsync(docxBuffer);
  const xml = await zip.file("word/document.xml")!.async("string");
  const matches = [...xml.matchAll(/<w:tcW w:type="pct" w:w="(\d+)%"/g)];
  return matches.map((m) => Number(m[1]));
}

describe("Case Brief DOCX table layout", () => {
  it("attribution table: Statement column is wider than Category and Source", async () => {
    const docxBuffer = await renderBriefToDocx(
      briefWithTable(["Statement", "Category", "Source"], [["a statement", "GROUNDED", "a-source.pdf"]]),
    );
    const widths = await headerCellWidths(docxBuffer);
    // First row of table cells: Statement, Category, Source (in that column order).
    const [statement, category, source] = widths;
    expect(statement).to.be.greaterThan(category!);
    expect(statement).to.be.greaterThan(source!);
  });

  it("a non-attribution table keeps equal column widths", async () => {
    const docxBuffer = await renderBriefToDocx(
      briefWithTable(["Date", "Event", "Note", "Ref"], [["d", "e", "n", "r"]]),
    );
    const widths = await headerCellWidths(docxBuffer);
    const [first, ...rest] = widths;
    for (const w of rest) expect(w).to.equal(first);
  });
});
