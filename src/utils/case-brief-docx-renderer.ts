import {
  Document,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  Packer,
  Footer,
  TableOfContents,
  WidthType,
  PageBreak,
} from "docx";
import type { BriefBlock, BriefDocument } from "./case-brief-document";

const DISCLAIMER = "AI-assisted draft — counsel must review.";

function formatDate(date: Date | null): string {
  return date ? date.toISOString().slice(0, 10) : "—";
}

/** Statement / Category / Source tables get a wider Statement column — equal thirds cramp the
 * long text column while leaving Category (a single word) mostly empty. Mirrors columnWidths()
 * in case-brief-pdf-renderer.ts, same policy for both output formats. Any other table keeps
 * equal widths. */
function columnWidthPercentages(headers: string[]): number[] {
  const isAttribution = headers.join("|") === "Statement|Category|Source";
  const weights = isAttribution ? [0.5, 0.15, 0.35] : headers.map(() => 1 / headers.length);
  return weights.map((w) => w * 100);
}

function tableFromBlock(block: Extract<BriefBlock, { type: "table" }>): Table {
  const widths = columnWidthPercentages(block.headers);

  const headerRow = new TableRow({
    children: block.headers.map(
      (h, i) =>
        new TableCell({
          width: { size: widths[i]!, type: WidthType.PERCENTAGE },
          children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })],
        }),
    ),
  });

  const dataRows = block.rows.map(
    (row) =>
      new TableRow({
        children: row.map(
          (cell, i) =>
            new TableCell({
              width: { size: widths[i]!, type: WidthType.PERCENTAGE },
              children: [new Paragraph({ text: cell })],
            }),
        ),
      }),
  );

  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [headerRow, ...dataRows] });
}

function paragraphsFromBlocks(blocks: BriefBlock[]): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case "heading1":
        out.push(new Paragraph({ heading: HeadingLevel.HEADING_1, text: block.text }));
        break;
      case "heading2":
        out.push(new Paragraph({ heading: HeadingLevel.HEADING_2, text: block.text }));
        break;
      case "paragraph":
        out.push(new Paragraph({ children: [new TextRun({ text: block.text, italics: block.italic })] }));
        break;
      case "notGenerated":
        out.push(
          new Paragraph({ children: [new TextRun({ text: block.reason ?? "Not generated.", italics: true })] }),
        );
        break;
      case "table":
        out.push(tableFromBlock(block));
        break;
    }
  }
  return out;
}

export async function renderBriefToDocx(doc: BriefDocument): Promise<Buffer> {
  const footerText = `${doc.cover.caseName} — ${formatDate(doc.cover.generatedAt)} — ${DISCLAIMER}`;

  const children: (Paragraph | Table)[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, text: doc.cover.caseName }),
    new Paragraph({ text: doc.cover.actionType ? `Action Type: ${doc.cover.actionType}` : "Action Type: —" }),
    new Paragraph({ text: doc.cover.jurisdiction ? `Jurisdiction: ${doc.cover.jurisdiction}` : "Jurisdiction: —" }),
    new Paragraph({ text: `Generated: ${formatDate(doc.cover.generatedAt)}` }),
    new Paragraph({ text: `Last Refreshed: ${formatDate(doc.cover.lastRefreshedAt)}` }),
    new Paragraph({ children: [new TextRun({ text: DISCLAIMER, italics: true })] }),
    new Paragraph({ children: [new PageBreak()] }),
    new TableOfContents("Table of Contents", { hyperlink: true, headingStyleRange: "1-2" }),
  ];

  for (const section of doc.sections) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, text: section.title }));
    children.push(...paragraphsFromBlocks(section.blocks));
  }

  const wordDoc = new Document({
    sections: [
      {
        footers: {
          default: new Footer({ children: [new Paragraph({ children: [new TextRun({ text: footerText })] })] }),
        },
        children,
      },
    ],
  });

  return Packer.toBuffer(wordDoc);
}
