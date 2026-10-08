import PDFDocument from "pdfkit";
import type { SecurityAuditEvent } from "@prisma/client";
import { SECURITY_AUDIT_ACTION_LABELS, SecurityAuditAction } from "../constants/security-audit.constants";
import type { AuditEventDisplay } from "../services/security-audit-describe";

// ── Look ─────────────────────────────────────────────────────────────────────────────────────
// The app's light-theme brand colours (packages/ui globals.css): near-black ink, deep gold accent,
// oxblood for warnings. Helvetica throughout — pdfkit's built-in font, nothing to embed.
const INK = "#1a1a1a";
const MUTED = "#6b6b6b";
const FAINT = "#9a9a9a";
const GOLD = "#8a6200";
const OXBLOOD = "#7a1f2b";
const GREEN = "#2e7d4f";
const RULE = "#e2dfd8";
const ZEBRA = "#f8f7f4";
const TILE = "#f4f2ed";

const MARGIN = 40;
const HEADER_BAND = 4;
const FOOTER_SPACE = 34;
const CELL_PAD_X = 6;
const CELL_PAD_Y = 5;
const BODY_SIZE = 7.8;
const NOT_APPLICABLE = "N/A";

/** Relative widths of the table's columns. */
const COLUMNS: { header: string; weight: number }[] = [
  { header: "Date & time (UTC)", weight: 0.12 },
  { header: "Action", weight: 0.17 },
  { header: "Outcome", weight: 0.08 },
  { header: "By", weight: 0.17 },
  { header: "Affected", weight: 0.21 },
  { header: "Details", weight: 0.25 },
];

export interface AuditLogPdfHeader {
  /** "Audit QA Firm", or "All organizations" for the platform-wide export. */
  scope: string;
  generatedAt: Date;
  generatedBy: string | null;
  /** The filters in words — "Sign-in, failed attempts only" — or "all activity". */
  filterSummary: string;
  /** How rows are ordered, in words: "newest first", "by action (A–Z)". */
  sort: string;
  rowCount: number;
  truncated: boolean;
  maxRows: number;
}

export interface AuditLogPdfEvent {
  event: SecurityAuditEvent;
  display: AuditEventDisplay;
}

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "UTC" });

function formatDate(date: Date): string {
  return DATE.format(date);
}

function formatDateTime(date: Date): string {
  return `${DATE.format(date)}, ${TIME.format(date).slice(0, 5)} UTC`;
}

/** Helvetica, pdfkit's built-in font, only covers Windows-1252 — an arrow comes out as "!’". The
 * app's table keeps the arrow; the PDF says it in words. */
export function pdfSafe(text: string): string {
  return text.replace(/\s*→\s*/g, " to ");
}

export function actionLabel(action: string): string {
  return SECURITY_AUDIT_ACTION_LABELS[action as SecurityAuditAction] ?? action;
}

/** One row's cells, in COLUMNS order — the same names and wording as the app's table. The time
 * cell is two lines: the date, then the clock time. */
export function auditLogPdfRow({ event, display }: AuditLogPdfEvent): string[] {
  return [
    `${formatDate(event.createdAt)}\n${TIME.format(event.createdAt)}`,
    actionLabel(event.action),
    event.outcome === "FAILURE" ? "Failed" : "Success",
    pdfSafe(display.actor),
    pdfSafe(display.target),
    pdfSafe(display.details),
  ];
}

/** Headline figures for the summary tiles. */
export function auditLogSummary(events: AuditLogPdfEvent[]) {
  const people = new Set(events.map((e) => e.event.actorId).filter(Boolean));
  const times = events.map((e) => e.event.createdAt.getTime());
  return {
    failed: events.filter((e) => e.event.outcome === "FAILURE").length,
    people: people.size,
    period: times.length ? { from: new Date(Math.min(...times)), to: new Date(Math.max(...times)) } : null,
  };
}

/** The audit log as a landscape A4 report: a branded title page header with the report's details
 * and summary figures, then the events as a table whose header row repeats on every page, a short
 * running header on continuation pages, and a footer with the page number on every page. pdfkit
 * has no table primitive, so rows are laid out by hand — a row that won't fit moves whole to the
 * next page rather than splitting mid-cell. */
export function renderAuditLogPdf(header: AuditLogPdfHeader, events: AuditLogPdfEvent[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      layout: "landscape",
      margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
      bufferPages: true,
      info: {
        Title: `${header.scope} — Security audit log`,
        Author: "ilovelawyer",
        Subject: "Security audit log",
        CreationDate: header.generatedAt,
      },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageWidth = doc.page.width;
    const usableWidth = pageWidth - MARGIN * 2;
    const widths = COLUMNS.map((c) => c.weight * usableWidth);
    const xs = widths.map((_, i) => MARGIN + widths.slice(0, i).reduce((a, b) => a + b, 0));
    const contentBottom = () => doc.page.height - MARGIN - FOOTER_SPACE;
    const summary = auditLogSummary(events);

    /** Writes text at an exact spot without letting pdfkit decide to start a new page. */
    const place = (text: string, x: number, y: number, options: PDFKit.Mixins.TextOptions = {}) => {
      const bottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.text(text, x, y, { lineBreak: options.width !== undefined, ...options });
      doc.page.margins.bottom = bottomMargin;
    };

    const brandBand = () => doc.rect(0, 0, pageWidth, HEADER_BAND).fill(GOLD);

    // ── Title block (first page) ──────────────────────────────────────────────────────────────
    brandBand();
    let y = MARGIN;
    doc.font("Helvetica-Bold").fontSize(10).fillColor(INK);
    place("ilovelawyer", MARGIN, y);
    doc.font("Helvetica-Bold").fontSize(7).fillColor(OXBLOOD);
    place("CONFIDENTIAL", MARGIN, y + 1.5, { width: usableWidth, align: "right", characterSpacing: 1.2 });

    y += 24;
    doc.font("Helvetica-Bold").fontSize(7.5).fillColor(GOLD);
    place("SECURITY AUDIT LOG", MARGIN, y, { characterSpacing: 1.4 });
    y += 13;
    doc.font("Helvetica-Bold").fontSize(20).fillColor(INK);
    place(header.scope, MARGIN, y, { width: usableWidth });
    y += 30;

    // Report details: four label/value columns.
    const details: [string, string][] = [
      ["PERIOD COVERED", summary.period ? `${formatDate(summary.period.from)} – ${formatDate(summary.period.to)}` : "No events"],
      ["FILTERS", header.filterSummary.charAt(0).toUpperCase() + header.filterSummary.slice(1)],
      ["ORDER", header.sort.charAt(0).toUpperCase() + header.sort.slice(1)],
      ["GENERATED", `${formatDateTime(header.generatedAt)}${header.generatedBy ? `\nby ${header.generatedBy}` : ""}`],
    ];
    const detailWidth = usableWidth / details.length;
    let detailsHeight = 0;
    details.forEach(([label, value], i) => {
      const x = MARGIN + i * detailWidth;
      doc.font("Helvetica-Bold").fontSize(6.5).fillColor(FAINT);
      place(label, x, y, { characterSpacing: 0.8 });
      doc.font("Helvetica").fontSize(9).fillColor(INK);
      place(value, x, y + 11, { width: detailWidth - 16 });
      detailsHeight = Math.max(detailsHeight, 11 + doc.heightOfString(value, { width: detailWidth - 16 }));
    });
    y += detailsHeight + 16;

    // Summary tiles.
    const tiles: [string, string][] = [
      [String(header.rowCount), header.rowCount === 1 ? "Event recorded" : "Events recorded"],
      [String(summary.failed), summary.failed === 1 ? "Failed attempt" : "Failed attempts"],
      [String(summary.people), summary.people === 1 ? "Person involved" : "People involved"],
    ];
    const tileGap = 10;
    const tileWidth = (usableWidth - tileGap * (tiles.length - 1)) / tiles.length;
    const tileHeight = 44;
    tiles.forEach(([figure, label], i) => {
      const x = MARGIN + i * (tileWidth + tileGap);
      doc.roundedRect(x, y, tileWidth, tileHeight, 4).fill(TILE);
      doc.rect(x, y, 3, tileHeight).fill(i === 1 && summary.failed > 0 ? OXBLOOD : GOLD);
      doc.font("Helvetica-Bold").fontSize(17).fillColor(i === 1 && summary.failed > 0 ? OXBLOOD : INK);
      place(figure, x + 14, y + 8);
      doc.font("Helvetica").fontSize(7.5).fillColor(MUTED);
      place(label, x + 14, y + 29);
    });
    y += tileHeight + 14;

    if (header.truncated) {
      const note = `This report lists the first ${header.maxRows.toLocaleString("en-GB")} of ${header.rowCount.toLocaleString("en-GB")} matching events, ${header.sort}. Narrow the date range or activity filter to include the rest.`;
      doc.font("Helvetica").fontSize(8);
      const noteHeight = doc.heightOfString(note, { width: usableWidth - 20 }) + 12;
      doc.roundedRect(MARGIN, y, usableWidth, noteHeight, 3).fill("#fbf3e4");
      doc.fillColor(GOLD);
      place(note, MARGIN + 10, y + 6, { width: usableWidth - 20 });
      y += noteHeight + 12;
    }

    // ── Table ──────────────────────────────────────────────────────────────────────────────────
    const drawTableHeader = (top: number): number => {
      const height = 20;
      doc.rect(MARGIN, top, usableWidth, height).fill(INK);
      doc.font("Helvetica-Bold").fontSize(6.8).fillColor("#ffffff");
      COLUMNS.forEach((column, i) => place(column.header.toUpperCase(), xs[i]! + CELL_PAD_X, top + 7, { characterSpacing: 0.6 }));
      return top + height;
    };

    const runningHeader = (): number => {
      brandBand();
      doc.font("Helvetica-Bold").fontSize(8).fillColor(INK);
      place(header.scope, MARGIN, MARGIN - 14);
      doc.font("Helvetica").fontSize(8).fillColor(MUTED);
      place("Security audit log · continued", MARGIN, MARGIN - 14, { width: usableWidth, align: "right" });
      return MARGIN + 4;
    };

    const cellFont = (column: number) => (column === 1 ? "Helvetica-Bold" : "Helvetica");
    const rowHeight = (cells: string[]) =>
      Math.max(
        ...cells.map((cell, i) => {
          doc.font(cellFont(i)).fontSize(BODY_SIZE);
          return doc.heightOfString(cell || NOT_APPLICABLE, { width: widths[i]! - CELL_PAD_X * 2, lineGap: 1 });
        }),
      ) +
      CELL_PAD_Y * 2;

    const drawRow = (cells: string[], top: number, index: number, failed: boolean): number => {
      const height = rowHeight(cells);
      if (index % 2 === 1) doc.rect(MARGIN, top, usableWidth, height).fill(ZEBRA);
      cells.forEach((cell, i) => {
        const x = xs[i]! + CELL_PAD_X;
        const width = widths[i]! - CELL_PAD_X * 2;
        const textTop = top + CELL_PAD_Y;
        if (i === 0) {
          const [date, time] = cell.split("\n");
          doc.font("Helvetica").fontSize(BODY_SIZE).fillColor(INK);
          place(date ?? "", x, textTop, { width });
          doc.fillColor(MUTED);
          place(time ?? "", x, textTop + BODY_SIZE + 2.5, { width });
          return;
        }
        if (i === 2) {
          const colour = failed ? OXBLOOD : GREEN;
          doc.circle(x + 2.5, textTop + BODY_SIZE / 2 - 0.5, 2.2).fill(colour);
          doc.font("Helvetica-Bold").fontSize(BODY_SIZE).fillColor(colour);
          place(cell, x + 8, textTop, { width: width - 8 });
          return;
        }
        const isEmpty = cell === NOT_APPLICABLE || cell === "";
        doc
          .font(cellFont(i))
          .fontSize(BODY_SIZE)
          .fillColor(isEmpty ? FAINT : i >= 4 ? "#3d3d3d" : INK);
        place(cell || NOT_APPLICABLE, x, textTop, { width, lineGap: 1 });
      });
      doc
        .moveTo(MARGIN, top + height)
        .lineTo(MARGIN + usableWidth, top + height)
        .lineWidth(0.5)
        .strokeColor(RULE)
        .stroke();
      return top + height;
    };

    doc.font("Helvetica-Bold").fontSize(9).fillColor(INK);
    place("Activity", MARGIN, y);
    y += 15;

    if (events.length === 0) {
      y = drawTableHeader(y);
      doc.font("Helvetica-Oblique").fontSize(9).fillColor(MUTED);
      place("Nothing was recorded for these filters.", MARGIN, y + 14, { width: usableWidth, align: "center" });
    } else {
      y = drawTableHeader(y);
      events.forEach((item, index) => {
        const cells = auditLogPdfRow(item);
        if (y + rowHeight(cells) > contentBottom()) {
          doc.addPage();
          y = drawTableHeader(runningHeader());
        }
        y = drawRow(cells, y, index, item.event.outcome === "FAILURE");
      });
      doc.font("Helvetica").fontSize(7.5).fillColor(FAINT);
      if (y + 20 > contentBottom()) {
        doc.addPage();
        y = runningHeader();
      }
      place(`End of report · ${events.length.toLocaleString("en-GB")} event${events.length === 1 ? "" : "s"} listed`, MARGIN, y + 10, {
        width: usableWidth,
        align: "center",
      });
    }

    // ── Footer on every page ────────────────────────────────────────────────────────────────
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const footerTop = doc.page.height - MARGIN - 12;
      doc
        .moveTo(MARGIN, footerTop - 6)
        .lineTo(MARGIN + usableWidth, footerTop - 6)
        .lineWidth(0.5)
        .strokeColor(RULE)
        .stroke();
      doc.font("Helvetica").fontSize(7).fillColor(MUTED);
      place(
        `Generated by ilovelawyer on ${formatDateTime(header.generatedAt)} · All times are UTC · Confidential: for the organization's internal security review only`,
        MARGIN,
        footerTop,
        { width: usableWidth * 0.8 },
      );
      doc.font("Helvetica-Bold").fontSize(7).fillColor(INK);
      place(`Page ${i - range.start + 1} of ${range.count}`, MARGIN, footerTop, { width: usableWidth, align: "right" });
    }

    doc.end();
  });
}
