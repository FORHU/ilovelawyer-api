import * as cheerio from "cheerio";
import PDFDocument from "pdfkit";
import { toWinAnsi } from "./data-export-report";
import { formatBytes } from "./upload-batch-limit";

// An email from the client's Gmail as a PDF for their case (EPIC #982, #986): the header block
// (From, To, Cc, Bcc, Date, Subject), the full body as text, and the list of attachments. Made
// with pdfkit like the API's other PDFs. Its built-in Helvetica is WinAnsi only, so text outside
// Latin-1 prints as "?" (see toWinAnsi); the original stays in the client's Gmail.

const MARGIN = 54;
const LABEL_WIDTH = 64;
const INK = "#1a1a1a";
const MUTED = "#666666";
const RULE = "#d9d9d9";

export interface EmailPdfInput {
  subject: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  /** Gmail only has Bcc on mail the client sent. */
  bcc: string | null;
  /** The Date header as sent, with the sender's time zone. */
  dateHeader: string | null;
  /** When Gmail received it (ISO), used when the Date header is missing. */
  date: string | null;
  messageIdHeader: string | null;
  body: string;
  attachments: { filename: string; size: number; addedToCase: boolean }[];
  /** The connected mailbox it was copied from. */
  mailbox: string | null;
  importedAt: Date;
}

const BLOCK_TAGS = "p, div, tr, h1, h2, h3, h4, h5, h6, table, blockquote, pre, section, article, header, footer, ul, ol";

/** An HTML email body as readable text: paragraphs and rows on their own lines, list items
 * marked, link targets kept beside their text (they can matter as evidence), images by their alt
 * text, and nothing from <head>, <style> or <script>. */
export function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  $("head, style, script, title, noscript, template").remove();
  $("br").replaceWith("\n");
  $("hr").replaceWith("\n----------\n");
  $("img").each((_, img) => {
    const alt = $(img).attr("alt")?.trim();
    $(img).replaceWith(alt ? `[${alt}]` : "");
  });
  $("a").each((_, a) => {
    const href = $(a).attr("href")?.trim() ?? "";
    const target = href.replace(/^mailto:/i, "");
    const text = $(a).text().trim();
    if (/^(https?:|mailto:)/i.test(href) && target && !text.includes(target)) $(a).append(` (${target})`);
  });
  $("li").each((_, li) => {
    // One item per line, without the blank line a block element gets.
    $(li).prepend("\n- ");
  });
  $("td, th").each((_, cell) => {
    $(cell).append(" ");
  });
  $(BLOCK_TAGS).each((_, el) => {
    $(el).prepend("\n").append("\n");
  });
  return normalizeText($.root().text());
}

/** Spaces collapsed within lines, lines trimmed, and at most one blank line in a row. */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t ​‌‍﻿]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The body to print: the plain-text part when the email has one (what the sender wrote, without
 * layout), else the HTML part as text. */
export function emailBodyText(textBody: string | null, htmlBody: string | null): string {
  if (textBody?.trim()) return normalizeText(textBody);
  if (htmlBody?.trim()) return htmlToText(htmlBody);
  return "";
}

function formatUtc(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : `${d.toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

export function renderEmailPdf(input: EmailPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const subject = input.subject?.trim() || "(no subject)";
    const doc = new PDFDocument({ margin: MARGIN, bufferPages: true, info: { Title: toWinAnsi(subject), Subject: "Email copied from Gmail" } });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const width = doc.page.width - MARGIN * 2;
    const rule = () => {
      const y = doc.y + 6;
      doc.moveTo(MARGIN, y).lineTo(MARGIN + width, y).lineWidth(0.5).strokeColor(RULE).stroke();
      doc.y = y + 10;
    };

    doc.font("Helvetica-Bold").fontSize(16).fillColor(INK).text(toWinAnsi(subject), { width });
    doc.moveDown(0.6);

    const headerRow = (label: string, value: string | null, fallback: string) => {
      const y = doc.y;
      doc.font("Helvetica-Bold").fontSize(9.5).fillColor(MUTED).text(label, MARGIN, y, { width: LABEL_WIDTH });
      doc
        .font("Helvetica")
        .fontSize(9.5)
        .fillColor(value ? INK : MUTED)
        .text(toWinAnsi(value ?? fallback), MARGIN + LABEL_WIDTH, y, { width: width - LABEL_WIDTH });
      doc.moveDown(0.25);
    };
    headerRow("From", input.from, "Not available");
    headerRow("To", input.to, "Not available");
    if (input.cc) headerRow("Cc", input.cc, "");
    headerRow("Bcc", input.bcc, "Not available (Gmail only keeps Bcc on mail you sent)");
    headerRow("Date", input.dateHeader ?? formatUtc(input.date), "Not available");
    headerRow("Subject", input.subject, "(no subject)");
    doc.x = MARGIN;
    rule();

    doc
      .font("Helvetica")
      .fontSize(10.5)
      .fillColor(input.body ? INK : MUTED)
      .text(toWinAnsi(input.body || "This email has no text."), MARGIN, doc.y, { width, lineGap: 2 });

    if (input.attachments.length > 0) {
      doc.moveDown(1);
      rule();
      doc.font("Helvetica-Bold").fontSize(10).fillColor(INK).text(`Attachments (${input.attachments.length})`, MARGIN, doc.y, { width });
      doc.moveDown(0.3);
      for (const a of input.attachments) {
        const note = a.addedToCase ? "added to this case as its own document" : "not added to this case";
        doc
          .font("Helvetica")
          .fontSize(9.5)
          .fillColor(INK)
          .text(toWinAnsi(`- ${a.filename} (${formatBytes(a.size)}), ${note}`), MARGIN, doc.y, { width });
      }
    }

    // Footer on every page: where this copy came from, and the page number. Drawn with the bottom
    // margin zeroed so pdfkit doesn't start a new page for it (as in the other PDF renderers).
    const footer = toWinAnsi(
      [
        `Copied from Gmail${input.mailbox ? ` (${input.mailbox})` : ""} on ${formatUtc(input.importedAt.toISOString())}`,
        input.messageIdHeader ? `Message-ID ${input.messageIdHeader}` : null,
      ]
        .filter(Boolean)
        .join(" - "),
    );
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      const y = doc.page.height - MARGIN + 14;
      doc.font("Helvetica").fontSize(7.5).fillColor(MUTED);
      doc.text(footer, MARGIN, y, { width: width - 60, lineBreak: false, ellipsis: true });
      doc.text(`Page ${i - range.start + 1} of ${range.count}`, MARGIN + width - 60, y, { width: 60, align: "right", lineBreak: false });
      doc.page.margins.bottom = bottom;
    }
    doc.end();
  });
}
