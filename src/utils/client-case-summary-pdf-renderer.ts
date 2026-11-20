import path from "path";
import PDFDocument from "pdfkit";
import type { CaseSummaryDocument, SummaryItem, SummarySection } from "./client-case-summary-document";

// The client's Case summary as a PDF (ilovelawyer-client#137): the ilovelawyer lockup, the case
// details in a panel, the AI-written summary (tagged as such), the stated deadlines set apart, the timeline with a date column, then the
// rest as bullets, and the disclaimer in a box. Every block is measured before it's drawn and
// moved whole to the next page when it wouldn't fit, so a row never splits from its background.
//
// Pretendard (SIL OFL 1.1, src/assets/fonts) rather than the built-in Helvetica the lawyer brief
// uses: a KR client's intake is written in Korean, which the standard PDF fonts can't draw.
// src/assets is copied to dist/assets by the build (package.json).

const ASSETS_DIR = path.join(__dirname, "../assets");
export const SUMMARY_FONT_REGULAR = path.join(ASSETS_DIR, "fonts/Pretendard-Regular.otf");
export const SUMMARY_FONT_BOLD = path.join(ASSETS_DIR, "fonts/Pretendard-Bold.otf");
export const SUMMARY_LOGO = path.join(ASSETS_DIR, "brand/ilovelawyer-lockup-light.png");

const M = 50;
const FOOTER_SPACE = 34;
const LOGO_HEIGHT = 26;
const DATE_COLUMN = 104;
const LABEL_COLUMN = 112;
const PAD = 12;

const C = {
  ink: "#1c1c1f",
  ink2: "#55555c",
  muted: "#8a8a92",
  line: "#e4e2dc",
  gold: "#8a6200",
  panel: "#f7f5f0",
  callout: "#fbf4e2",
  calloutBar: "#c08a12",
  boxLine: "#dedbd3",
  boxFill: "#fafaf8",
  chip: "#efece5",
};

const T = { body: 10.5, lead: 11, date: 9.5, note: 9.5, source: 8.5, heading: 12.5, tag: 7.5 };
const GAP = { text: 1.5, afterItem: 7, afterSection: 14 };

export function renderCaseSummaryToPdf(summary: CaseSummaryDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: M, left: M, right: M, bottom: M + FOOTER_SPACE },
      bufferPages: true,
      info: { Title: `${summary.kicker} — ${summary.title}`, Subject: summary.disclaimer, Author: "ilovelawyer" },
      lang: summary.lang,
    });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.registerFont("Body", SUMMARY_FONT_REGULAR);
    doc.registerFont("Bold", SUMMARY_FONT_BOLD);
    const page = new Page(doc);

    drawHeader(doc, page, summary);
    drawDetails(doc, page, summary);
    if (summary.aiSummary) {
      page.heading(summary.aiSummary.label, 40, summary.aiSummary.tag);
      page.paragraph(summary.aiSummary.text);
    }
    if (summary.description) {
      page.heading(summary.description.label);
      page.quote(summary.description.text);
    }
    for (const section of summary.sections) drawSection(page, section);
    page.disclaimer(summary.disclaimer);

    drawFooters(doc, summary);
    doc.end();
  });
}

/** The page cursor and the drawing pieces, each measured first so it can move whole to a new page. */
class Page {
  readonly width: number;
  constructor(private readonly doc: PDFKit.PDFDocument) {
    this.width = doc.page.width - M * 2;
  }

  private get bottom() {
    return this.doc.page.height - this.doc.page.margins.bottom;
  }

  /** Room for `height` more points here, or a fresh page. */
  ensure(height: number) {
    if (this.doc.y + height > this.bottom) this.doc.addPage();
  }

  /** Vertical space; none at the top of a fresh page. */
  space(points: number) {
    if (this.doc.y > this.doc.page.margins.top + 1) this.doc.y += points;
  }

  private height(font: "Body" | "Bold", size: number, text: string, width: number, lineGap = 0) {
    return this.doc.font(font).fontSize(size).heightOfString(text, { width, lineGap });
  }

  /** A section title with a short gold tick and a hairline, kept on the page with its first row.
   * `tag`: a small pill on the right (the summary's "AI-written · check it against what you said"). */
  heading(title: string, firstRowHeight = 40, tag?: string) {
    const { doc } = this;
    const tagWidth = tag ? doc.font("Body").fontSize(T.tag).widthOfString(tag) + 14 : 0;
    const titleWidth = this.width - 10 - (tag ? tagWidth + 10 : 0);
    const h = this.height("Bold", T.heading, title, titleWidth);
    this.ensure(h + 10 + firstRowHeight);
    const y = doc.y;
    doc.rect(M, y + 3, 3, h - 6).fill(C.gold);
    if (tag) {
      const pillY = y + (h - 15) / 2;
      doc.roundedRect(M + this.width - tagWidth, pillY, tagWidth, 15, 7.5).fill(C.chip);
      doc
        .font("Body")
        .fontSize(T.tag)
        .fillColor(C.ink2)
        .text(tag, M + this.width - tagWidth + 7, pillY + 3.6, { width: tagWidth - 14, lineBreak: false });
    }
    doc.font("Bold").fontSize(T.heading).fillColor(C.ink).text(title, M + 10, y, { width: titleWidth });
    const ruleY = Math.max(doc.y, y + h) + 3;
    doc.moveTo(M, ruleY).lineTo(M + this.width, ruleY).lineWidth(0.5).strokeColor(C.line).stroke();
    doc.x = M;
    doc.y = ruleY + 8;
  }

  /** A plain paragraph in reading size (the AI-written summary). */
  paragraph(text: string) {
    const { doc } = this;
    const h = this.height("Body", T.lead, text, this.width, 2.5);
    this.ensure(Math.min(h, 60));
    doc.font("Body").fontSize(T.lead).fillColor(C.ink).text(text, M, doc.y, { width: this.width, lineGap: 2.5 });
    doc.x = M;
    doc.y += GAP.afterSection;
  }

  /** The client's own description, with a gold bar down its left. */
  quote(text: string) {
    const { doc } = this;
    const w = this.width - 14;
    const h = this.height("Body", T.body, text, w, GAP.text);
    this.ensure(h);
    const y = doc.y;
    doc.rect(M, y, 2, h).fill(C.gold);
    doc.font("Body").fontSize(T.body).fillColor(C.ink).text(text, M + 14, y, { width: w, lineGap: GAP.text });
    doc.x = M;
    doc.y += GAP.afterSection;
  }

  /** How tall an item's text, note and source run at `width`. */
  itemHeight(item: SummaryItem, width: number) {
    let h = this.height("Body", T.body, item.text, width, GAP.text);
    if (item.note) h += this.height("Body", T.note, item.note, width) + 1;
    if (item.source) h += this.height("Body", T.source, item.source, width) + 1;
    return h;
  }

  /** The item's text, then its note and source in smaller type, starting at (x, y). */
  itemBody(item: SummaryItem, x: number, y: number, width: number) {
    const { doc } = this;
    doc.font("Body").fontSize(T.body).fillColor(C.ink).text(item.text, x, y, { width, lineGap: GAP.text });
    if (item.note) doc.font("Body").fontSize(T.note).fillColor(C.ink2).text(item.note, x, doc.y + 1, { width });
    if (item.source) doc.font("Body").fontSize(T.source).fillColor(C.muted).text(item.source, x, doc.y + 1, { width });
  }

  bullet(item: SummaryItem) {
    const { doc } = this;
    const x = M + 14;
    const w = this.width - 14;
    this.ensure(this.itemHeight(item, w));
    const y = doc.y;
    doc.circle(M + 4, y + 6.5, 1.7).fill(C.gold);
    this.itemBody(item, x, y, w);
    doc.x = M;
    doc.y += GAP.afterItem;
  }

  /** A row with the date in its own column: the timeline, and (on a tinted band) the deadlines. */
  dated(item: SummaryItem, band: boolean) {
    const { doc } = this;
    const inset = band ? PAD : 0;
    const x = M + inset + DATE_COLUMN;
    const w = this.width - inset * 2 - DATE_COLUMN;
    const date = item.date ?? "";
    const h = Math.max(this.itemHeight(item, w), this.height("Bold", T.date, date, DATE_COLUMN - 10));
    const padY = band ? 7 : 0;
    this.ensure(h + padY * 2);
    const y = doc.y;
    if (band) {
      doc.rect(M, y, this.width, h + padY * 2).fill(C.callout);
      doc.rect(M, y, 3, h + padY * 2).fill(C.calloutBar);
    }
    doc
      .font("Bold")
      .fontSize(T.date)
      .fillColor(band ? C.ink : C.gold)
      .text(date, M + inset, y + padY + 1, { width: DATE_COLUMN - 10 });
    this.itemBody(item, x, y + padY, w);
    doc.x = M;
    doc.y = y + h + padY * 2 + (band ? 2 : GAP.afterItem);
  }

  disclaimer(text: string) {
    const { doc } = this;
    const w = this.width - PAD * 2;
    const h = this.height("Body", T.note, text, w) + PAD * 1.4;
    doc.y += 4;
    this.ensure(h);
    const y = doc.y;
    doc.roundedRect(M, y, this.width, h, 4).fillAndStroke(C.boxFill, C.boxLine);
    doc.font("Body").fontSize(T.note).fillColor(C.ink2).text(text, M + PAD, y + PAD * 0.7, { width: w });
    doc.x = M;
    doc.y = y + h;
  }
}

function drawHeader(doc: PDFKit.PDFDocument, page: Page, summary: CaseSummaryDocument) {
  const top = M;
  doc.image(SUMMARY_LOGO, M, top, { height: LOGO_HEIGHT });
  doc
    .font("Bold")
    .fontSize(8.5)
    .fillColor(C.gold)
    .text(summary.kicker.toUpperCase(), M, top + 9, { width: page.width, align: "right", characterSpacing: 1.2 });

  doc.y = top + LOGO_HEIGHT + 22;
  doc.font("Bold").fontSize(22).fillColor(C.ink).text(summary.title, M, doc.y, { width: page.width, lineGap: 1 });
  doc.font("Body").fontSize(10).fillColor(C.ink2).text(summary.asOf, M, doc.y + 3, { width: page.width });
  doc.x = M;
  doc.y += 14;
}

/** The case details as label / value rows on a tinted panel. */
function drawDetails(doc: PDFKit.PDFDocument, page: Page, summary: CaseSummaryDocument) {
  if (!summary.details.length) return;
  const valueWidth = page.width - PAD * 2 - LABEL_COLUMN;
  const rows = summary.details.map((d) => ({ ...d, h: doc.font("Body").fontSize(T.body).heightOfString(d.value, { width: valueWidth }) }));
  const height = rows.reduce((sum, r) => sum + r.h + 5, 0) - 5 + PAD * 2;
  page.ensure(height);
  const y = doc.y;
  doc.roundedRect(M, y, page.width, height, 5).fill(C.panel);
  let rowY = y + PAD;
  for (const r of rows) {
    doc.font("Bold").fontSize(9).fillColor(C.ink2).text(r.label, M + PAD, rowY + 1.2, { width: LABEL_COLUMN - 8 });
    doc.font("Body").fontSize(T.body).fillColor(C.ink).text(r.value, M + PAD + LABEL_COLUMN, rowY, { width: valueWidth });
    rowY += r.h + 5;
  }
  doc.x = M;
  doc.y = y + height + 18;
}

function drawSection(page: Page, section: SummarySection) {
  const first = section.items[0]!;
  page.heading(section.title, page.itemHeight(first, page.width - DATE_COLUMN - PAD * 2) + 16);
  for (const item of section.items) {
    if (section.kind === "callout") page.dated(item, true);
    else if (section.kind === "dated") page.dated(item, false);
    else page.bullet(item);
  }
  // A little air under a tinted block, the usual gap under the rest.
  page.space(section.kind === "callout" ? GAP.afterSection + 4 : GAP.afterSection - GAP.afterItem);
}

/** "ilovelawyer · <title>" on the left, "Page n of N" on the right, on every page. Drawn below the
 * bottom margin, so the margin is lifted for the draw, or pdfkit would add a page for it (see
 * case-brief-pdf-renderer.ts's footer). */
function drawFooters(doc: PDFKit.PDFDocument, summary: CaseSummaryDocument) {
  const range = doc.bufferedPageRange();
  const width = doc.page.width - M * 2;
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const margin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = doc.page.height - M;
    doc.moveTo(M, y - 8).lineTo(M + width, y - 8).lineWidth(0.5).strokeColor(C.line).stroke();
    const pageText = summary.pageLabel.replace("{n}", String(i - range.start + 1)).replace("{total}", String(range.count));
    doc.font("Body").fontSize(8).fillColor(C.muted);
    const pageWidth = doc.widthOfString(pageText);
    doc.text(`ilovelawyer · ${summary.title}`, M, y, { width: width - pageWidth - 16, lineBreak: false, ellipsis: true });
    doc.text(pageText, M + width - pageWidth, y, { lineBreak: false });
    doc.page.margins.bottom = margin;
  }
}
