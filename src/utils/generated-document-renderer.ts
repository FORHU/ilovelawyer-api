import { Document, Paragraph, TextRun, HeadingLevel, Packer, Footer, AlignmentType } from "docx";
import PDFDocument from "pdfkit";

// Renders chat-wonder's drafted legal text (affidavits, pleadings, contracts) as a plain document.
// Deliberately separate from the case-brief renderers: those wrap a BriefDocument in a cover page
// (Action Type / Jurisdiction / Last Refreshed) and a table of contents, which make no sense for a
// document the user will sign or file — this one outputs just the drafted text.

const DISCLAIMER = "AI-assisted draft — counsel must review.";
const PAGE_MARGIN = 72;

interface Segment {
  text: string;
  bold: boolean;
}

type Block =
  | { type: "heading"; text: string }
  // `lines` keeps the drafter's own line breaks — signature, notary and caption blocks are
  // single-newline-separated lines that must not be merged into one paragraph.
  | { type: "paragraph"; lines: Segment[][] };

/** Splits `**bold**` spans out of a line. Unmatched markers are left as literal text. */
function parseInline(line: string): Segment[] {
  const segments: Segment[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m.index > last) segments.push({ text: line.slice(last, m.index), bold: false });
    segments.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < line.length) segments.push({ text: line.slice(last), bold: false });
  return segments.length ? segments : [{ text: "", bold: false }];
}

/** Removes the markdown the model wraps drafts in: a ```markdown fence around the whole document,
 * and `---` horizontal rules — neither belongs in a Word/PDF file. */
function stripMarkdownNoise(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !/^\s*```/.test(line) && !/^\s*([-*_])\1{2,}\s*$/.test(line))
    .join("\n");
}

function toBlocks(content: string): Block[] {
  return stripMarkdownNoise(content)
    .split(/\n\s*\n/)
    .map((chunk) => chunk.replace(/^\n+|\s+$/g, ""))
    .filter((chunk) => chunk.trim())
    .map((chunk): Block => {
      const heading = /^#{1,6}\s+(.*)$/.exec(chunk);
      if (heading && !chunk.includes("\n")) return { type: "heading", text: heading[1].replace(/\*\*/g, "").trim() };
      return { type: "paragraph", lines: chunk.split("\n").map((l) => parseInline(l.replace(/^#{1,6}\s+/, ""))) };
    });
}

export async function renderGeneratedDocx(content: string): Promise<Buffer> {
  const children = toBlocks(content).map((block) => {
    if (block.type === "heading") {
      return new Paragraph({
        heading: HeadingLevel.HEADING_2,
        alignment: AlignmentType.CENTER,
        spacing: { before: 200, after: 200 },
        children: [new TextRun({ text: block.text, bold: true })],
      });
    }
    const runs = block.lines.flatMap((segments, i) =>
      segments.map((s, j) => new TextRun({ text: s.text, bold: s.bold, break: i > 0 && j === 0 ? 1 : undefined })),
    );
    return new Paragraph({ spacing: { after: 160 }, children: runs });
  });

  const wordDoc = new Document({
    styles: { default: { document: { run: { font: "Times New Roman", size: 24 } } } },
    sections: [
      {
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: DISCLAIMER, italics: true, size: 16, color: "666666" })],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  return Packer.toBuffer(wordDoc);
}

// pdfkit's built-in fonts are WinAnsi only — the peso sign isn't in that set and renders as junk.
const toWinAnsi = (text: string) => text.replace(/₱/g, "PHP ");

export function renderGeneratedPdf(content: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: PAGE_MARGIN, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // Same approach (and reason) as case-brief-pdf-renderer's footer: pdfkit's .text() paginates if
    // the line sits below the bottom margin, and pageAdded would re-enter this handler forever, so
    // the bottom margin is zeroed only while the footer is drawn.
    const drawFooter = () => {
      const { x: cursorX, y: cursorY } = doc;
      const bottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc
        .font("Helvetica-Oblique")
        .fontSize(8)
        .fillColor("#666666")
        .text(DISCLAIMER, PAGE_MARGIN, doc.page.height - 45, {
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

    for (const block of toBlocks(content)) {
      if (block.type === "heading") {
        doc.font("Times-Bold").fontSize(13).text(toWinAnsi(block.text), { align: "center" });
        doc.moveDown(0.6);
        continue;
      }
      for (const segments of block.lines) {
        segments.forEach((s, i) => {
          doc
            .font(s.bold ? "Times-Bold" : "Times-Roman")
            .fontSize(12)
            .text(toWinAnsi(s.text), { continued: i < segments.length - 1 });
        });
      }
      doc.moveDown(0.6);
    }

    doc.end();
  });
}
