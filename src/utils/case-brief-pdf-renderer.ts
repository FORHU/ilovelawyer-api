import PDFDocument from "pdfkit";
import type { BriefBlock, BriefDocument } from "./case-brief-document";

const DISCLAIMER = "AI-assisted draft — counsel must review.";
const PAGE_MARGIN = 50;

function formatDate(date: Date | null): string {
  return date ? date.toISOString().slice(0, 10) : "—";
}

/** pdfkit has no table primitive — this hand-rolls a simple fixed-column-width row renderer.
 * Deliberately simple: PDF is a second output format from the same BriefDocument model, not a
 * separately art-directed layout, so cell wrapping beyond pdfkit's own `text()` wrapping and
 * page-break-mid-table are both out of scope for v1. */
function drawTable(doc: PDFKit.PDFDocument, headers: string[], rows: string[][]) {
  const usableWidth = doc.page.width - PAGE_MARGIN * 2;
  const colWidth = usableWidth / headers.length;

  const drawRow = (cells: string[], bold: boolean) => {
    const startY = doc.y;
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9);
    cells.forEach((cell, i) => {
      doc.text(cell, PAGE_MARGIN + i * colWidth, startY, { width: colWidth - 8 });
    });
    const rowHeight = Math.max(doc.heightOfString(cells[0] || "", { width: colWidth - 8 }), 14);
    doc.y = startY + rowHeight + 4;
    doc
      .moveTo(PAGE_MARGIN, doc.y - 2)
      .lineTo(PAGE_MARGIN + usableWidth, doc.y - 2)
      .strokeColor("#cccccc")
      .stroke();
  };

  drawRow(headers, true);
  for (const row of rows) drawRow(row, false);
  doc.moveDown(0.5);
}

function drawBlock(doc: PDFKit.PDFDocument, block: BriefBlock) {
  switch (block.type) {
    case "heading1":
      doc.font("Helvetica-Bold").fontSize(16).text(block.text);
      doc.moveDown(0.3);
      break;
    case "heading2":
      doc.font("Helvetica-Bold").fontSize(13).text(block.text);
      doc.moveDown(0.2);
      break;
    case "paragraph":
      doc
        .font(block.italic ? "Helvetica-Oblique" : "Helvetica")
        .fontSize(10)
        .text(block.text);
      doc.moveDown(0.4);
      break;
    case "notGenerated":
      doc
        .font("Helvetica-Oblique")
        .fontSize(10)
        .fillColor("#666666")
        .text(block.reason ?? "Not generated.");
      doc.fillColor("#000000");
      doc.moveDown(0.4);
      break;
    case "table":
      drawTable(doc, block.headers, block.rows);
      break;
  }
}

export function renderBriefToPdf(document: BriefDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: PAGE_MARGIN, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const footerText = `${document.cover.caseName} — ${formatDate(document.cover.generatedAt)} — ${DISCLAIMER}`;
    const drawFooter = () => {
      // Reproduced locally as a RangeError: Maximum call stack size exceeded before this fix.
      // pdfkit's .text() always runs through LineWrapper, which decides whether to paginate by
      // checking `y + lineHeight > page.height - page.margins.bottom` — regardless of whether the
      // call was given an explicit x/y. The footer sits at/past that bottom-margin line by
      // design, so LineWrapper called continueOnNewPage() itself, which fires `pageAdded` again,
      // which calls drawFooter() again, which fails the same check again — infinite recursion
      // until the stack blows. (lineBreak: false does NOT prevent this — it only skips wrapping a
      // single line's *width*, not this vertical fit check.)
      // Fix: zero out the bottom margin only for the duration of this draw, so pdfkit's own fit
      // check sees the full page height as available and never decides to paginate for a footer
      // that's deliberately drawn past the normal content margin.
      const { x: cursorX, y: cursorY } = doc;
      const bottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const bottom = doc.page.height - PAGE_MARGIN + 15;
      doc
        .font("Helvetica")
        .fontSize(8)
        .fillColor("#666666")
        .text(footerText, PAGE_MARGIN, bottom, {
          width: doc.page.width - PAGE_MARGIN * 2,
          align: "center",
        });
      doc.fillColor("#000000");
      doc.page.margins.bottom = bottomMargin;
      doc.x = cursorX;
      doc.y = cursorY;
    };
    doc.on("pageAdded", drawFooter);
    drawFooter(); // pageAdded doesn't fire for the first page created by the constructor

    doc.font("Helvetica-Bold").fontSize(22).text(document.cover.caseName);
    doc
      .font("Helvetica")
      .fontSize(11)
      .text(`Action Type: ${document.cover.actionType ?? "—"}`)
      .text(`Jurisdiction: ${document.cover.jurisdiction ?? "—"}`)
      .text(`Generated: ${formatDate(document.cover.generatedAt)}`)
      .text(`Last Refreshed: ${formatDate(document.cover.lastRefreshedAt)}`);
    doc.font("Helvetica-Oblique").fontSize(10).text(DISCLAIMER);
    doc.moveDown(1);

    for (const section of document.sections) {
      doc.addPage();
      doc.font("Helvetica-Bold").fontSize(18).text(section.title);
      doc.moveDown(0.5);
      for (const block of section.blocks) drawBlock(doc, block);
    }

    doc.end();
  });
}
