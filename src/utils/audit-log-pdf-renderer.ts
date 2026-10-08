import PDFDocument from "pdfkit";
import type { SecurityAuditEvent } from "@prisma/client";
import { SECURITY_AUDIT_ACTION_LABELS, SecurityAuditAction } from "../constants/security-audit.constants";
import type { AuditEventDisplay } from "../services/security-audit-describe";

const MARGIN = 36;
const CELL_PADDING = 6;
const ROW_GAP = 5;
const FONT_SIZE = 7.5;
const MIN_ROW_HEIGHT = 10;

/** Relative widths of the table's columns — Details takes the slack. */
const COLUMNS: { header: string; weight: number }[] = [
  { header: "Time (UTC)", weight: 0.11 },
  { header: "Action", weight: 0.15 },
  { header: "Outcome", weight: 0.06 },
  { header: "By", weight: 0.14 },
  { header: "Affected", weight: 0.19 },
  { header: "Details", weight: 0.26 },
  { header: "IP address", weight: 0.09 },
];

export interface AuditLogPdfHeader {
  /** "Audit QA Firm", or "All organizations" for the platform-wide export. */
  scope: string;
  generatedAt: Date;
  generatedBy: string | null;
  /** Human-readable filters, e.g. ["Activity: auth.", "From: 2026-10-01"]. Empty = everything. */
  filters: string[];
  rowCount: number;
  truncated: boolean;
  maxRows: number;
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

export function actionLabel(action: string): string {
  return SECURITY_AUDIT_ACTION_LABELS[action as SecurityAuditAction] ?? action;
}

export interface AuditLogPdfEvent {
  event: SecurityAuditEvent;
  display: AuditEventDisplay;
}

/** One row's cells, in COLUMNS order — the same names and wording as the app's table. */
export function auditLogPdfRow({ event, display }: AuditLogPdfEvent): string[] {
  return [
    formatTimestamp(event.createdAt),
    actionLabel(event.action),
    event.outcome === "FAILURE" ? "Failed" : "OK",
    display.actor,
    display.target,
    display.details,
    display.ip,
  ];
}

/** The audit log as a landscape A4 table: a title block, then one row per event, the header row
 * repeated on every page and "Page n of m" in each footer. pdfkit has no table primitive, so rows
 * are laid out by hand the same way case-brief-pdf-renderer.ts does — a row that won't fit moves
 * whole to the next page rather than splitting mid-cell. */
export function renderAuditLogPdf(header: AuditLogPdfHeader, events: AuditLogPdfEvent[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: MARGIN, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const usableWidth = doc.page.width - MARGIN * 2;
    const widths = COLUMNS.map((c) => c.weight * usableWidth);
    const xs = widths.map((_, i) => MARGIN + widths.slice(0, i).reduce((a, b) => a + b, 0));
    const bottomLimit = () => doc.page.height - MARGIN - 14;

    const rowHeight = (cells: string[]) =>
      Math.max(MIN_ROW_HEIGHT, ...cells.map((cell, i) => doc.heightOfString(cell || " ", { width: widths[i]! - CELL_PADDING })));

    const drawRow = (cells: string[], options: { bold?: boolean; shade?: boolean; failed?: boolean } = {}) => {
      doc.font(options.bold ? "Helvetica-Bold" : "Helvetica").fontSize(FONT_SIZE);
      const height = rowHeight(cells);
      const top = doc.y;
      if (options.shade) {
        doc.rect(MARGIN, top - ROW_GAP / 2, usableWidth, height + ROW_GAP).fill("#f3f3f3");
      }
      cells.forEach((cell, i) => {
        doc.fillColor(options.failed && i === 2 ? "#b42318" : "#111111").text(cell, xs[i]!, top, { width: widths[i]! - CELL_PADDING });
      });
      doc.fillColor("#000000");
      doc.y = top + height + ROW_GAP;
      doc
        .moveTo(MARGIN, doc.y - ROW_GAP / 2)
        .lineTo(MARGIN + usableWidth, doc.y - ROW_GAP / 2)
        .lineWidth(0.5)
        .strokeColor("#d0d0d0")
        .stroke();
    };
    const drawHeaderRow = () => drawRow(COLUMNS.map((c) => c.header), { bold: true, shade: true });

    // Title block
    doc.font("Helvetica-Bold").fontSize(16).text("Security audit log");
    doc.font("Helvetica").fontSize(9).fillColor("#333333");
    doc.text(header.scope);
    doc.text(`Generated ${formatTimestamp(header.generatedAt)} UTC${header.generatedBy ? ` by ${header.generatedBy}` : ""}`);
    doc.text(`Filters: ${header.filters.length ? header.filters.join(" · ") : "none (all activity)"}`);
    doc.text(
      header.truncated
        ? `${header.rowCount} events — the newest ${header.maxRows} only; narrow the date range for older events.`
        : `${header.rowCount} event${header.rowCount === 1 ? "" : "s"}, newest first.`,
    );
    doc.fillColor("#000000").moveDown(0.8);

    if (events.length === 0) {
      doc.font("Helvetica-Oblique").fontSize(10).text("Nothing recorded for these filters.");
    } else {
      drawHeaderRow();
      for (const item of events) {
        const cells = auditLogPdfRow(item);
        doc.font("Helvetica").fontSize(FONT_SIZE);
        if (doc.y + rowHeight(cells) + ROW_GAP > bottomLimit()) {
          doc.addPage();
          drawHeaderRow();
        }
        drawRow(cells, { failed: item.event.outcome === "FAILURE" });
      }
    }

    // Footers, once every page exists. The bottom margin is zeroed while drawing so pdfkit's
    // fit check doesn't start a new page for a footer drawn below it (see case-brief-pdf-renderer).
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const bottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc
        .font("Helvetica")
        .fontSize(7)
        .fillColor("#666666")
        .text(`${header.scope} — security audit log — page ${i - range.start + 1} of ${range.count}`, MARGIN, doc.page.height - MARGIN + 4, {
          width: usableWidth,
          align: "center",
        });
      doc.page.margins.bottom = bottomMargin;
    }
    doc.fillColor("#000000");
    doc.end();
  });
}
