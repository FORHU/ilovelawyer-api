import PDFDocument from "pdfkit";

export interface ExportReportListing {
  title: string;
  total: number;
  shown: Array<{ label: string; when?: string }>;
}

export interface ExportReportInput {
  generatedAt: Date;
  account: { name: string | null; email: string; username: string | null; createdAt: Date | null };
  /** Rows per table, only those with data. Keys are model names, shown in plain words. */
  counts: Record<string, number>;
  listings: ExportReportListing[];
  files: {
    included: Array<{ path: string }>;
    skipped: Array<{ name: string; reason: string }>;
  };
  /** What the export deliberately leaves out, and why. */
  notice: string;
}

const MARGIN = 54;
const FOOTER_NOTE = "The complete record is in data.json. This report is a readable summary of it.";

// pdfkit's built-in fonts are WinAnsi only. Typographic punctuation is mapped to plain ASCII and
// anything else outside Latin-1 becomes "?" rather than junk; the exact text is in data.json.
const PUNCTUATION: Record<string, string> = { "–": "-", "—": "-", "‘": "'", "’": "'", "“": '"', "”": '"', "…": "...", "₱": "PHP " };
export function toWinAnsi(text: string): string {
  return text
    .replace(/[–—‘’“”…₱]/g, (ch) => PUNCTUATION[ch] ?? ch)
    .replace(/[^\u0009\u000a -~ -ÿ]/g, "?");
}

/** "CaseClaim" -> "Case claim" */
export function humanizeModel(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatDate(date: Date | string | null | undefined): string {
  if (!date) return "-";
  const d = typeof date === "string" ? new Date(date) : date;
  return Number.isNaN(d.getTime()) ? "-" : d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function renderDataExportReport(input: ExportReportInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: MARGIN, bufferPages: true, info: { Title: "Your data from ilovelawyer" } });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const heading = (text: string) => {
      doc.moveDown(1).font("Helvetica-Bold").fontSize(13).fillColor("#000000").text(toWinAnsi(text));
      doc.moveDown(0.3).font("Helvetica").fontSize(10);
    };
    const line = (text: string) => doc.font("Helvetica").fontSize(10).fillColor("#000000").text(toWinAnsi(text));
    const muted = (text: string) => doc.font("Helvetica").fontSize(9).fillColor("#555555").text(toWinAnsi(text)).fillColor("#000000");

    doc.font("Helvetica-Bold").fontSize(20).text("Your data from ilovelawyer");
    doc.moveDown(0.3);
    muted(`Prepared ${formatDate(input.generatedAt)} at your request.`);
    muted(FOOTER_NOTE);

    heading("What is in this download");
    line("README.pdf - this report.");
    line("data.json - the complete record of the data we hold about you, in a machine-readable format.");
    line("files/ - the files you uploaded, in their original form.");

    heading("Your account");
    line(`Name: ${input.account.name ?? "-"}`);
    line(`Email: ${input.account.email}`);
    line(`Username: ${input.account.username ?? "-"}`);
    line(`Account created: ${formatDate(input.account.createdAt)}`);

    heading("What we hold about you");
    const rows = Object.entries(input.counts).sort(([a], [b]) => a.localeCompare(b));
    if (rows.length === 0) {
      line("Nothing beyond your account details.");
    } else {
      for (const [model, count] of rows) line(`${humanizeModel(model)}: ${count}`);
    }

    for (const listing of input.listings) {
      if (listing.total === 0) continue;
      heading(`${listing.title} (${listing.total})`);
      for (const item of listing.shown) line(item.when ? `${item.label}  -  ${item.when}` : item.label);
      if (listing.total > listing.shown.length) muted(`Showing ${listing.shown.length} of ${listing.total}. The full list is in data.json.`);
    }

    heading("Files");
    if (input.files.included.length === 0 && input.files.skipped.length === 0) {
      line("No uploaded files.");
    } else {
      line(`${input.files.included.length} file${input.files.included.length === 1 ? "" : "s"} included in the files/ folder.`);
      for (const file of input.files.skipped) {
        muted(`Not included: ${file.name} (${file.reason})`);
      }
    }

    heading("What is not included");
    line(input.notice);

    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(pages.start + i);
      // Same approach as the other PDF renderers: write below the bottom margin without letting
      // pdfkit paginate, by zeroing the margin for this one line.
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font("Helvetica").fontSize(8).fillColor("#777777").text(`Page ${i + 1} of ${pages.count}`, MARGIN, doc.page.height - 36, {
        width: doc.page.width - MARGIN * 2,
        align: "center",
      });
      doc.page.margins.bottom = bottom;
    }

    doc.end();
  });
}
