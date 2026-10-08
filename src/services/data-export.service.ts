import type { Readable } from "stream";
import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { getObjectStream } from "../utils/s3";
import { ZipWriter, type ZipSink } from "../utils/zip-stream";
import { renderDataExportReport, toWinAnsi, type ExportReportListing } from "../utils/data-export-report";

/** Tables left out of a user's export on purpose.
 * - Session: refresh tokens, which are credentials, not the user's data.
 * - TenantSetting: operator configuration; the user only appears as "last edited by". */
export const EXPORT_EXCLUDED_MODELS: ReadonlySet<string> = new Set(["Session", "TenantSetting"]);

/** Tables where only the rows the user themselves caused belong in their export. Their other
 * rows (other people acting on the user's case) are not the user's data. */
const ONLY_DIRECT: ReadonlySet<string> = new Set(["AuditEvent", "CaseAccess"]);

/** Any column whose name looks like a credential is dropped from the export. */
const SECRET_KEY = /pass(word)?|secret|token|api[-_]?key|authorization|cookie/i;

const BATCH_SIZE = 500;

/** The classic ZIP format allows 65,535 entries; two are reserved for data.json and README.pdf. */
const MAX_FILE_ENTRIES = 60_000;
const MAX_FILE_BYTES = 0xffffffff;
const LISTING_LIMIT = 100;
const ACTIVITY_COLLECT_LIMIT = 5000;

export interface ExportSection {
  model: string;
  /** Prisma delegate name, e.g. "caseClaim" for the model "CaseClaim". */
  delegate: string;
  where: Record<string, unknown>;
  orderBy: Array<Record<string, "asc">>;
  /** Why these rows belong to the user: they reference the user directly, or sit on a case or
   * consultation the user owns. */
  via: Array<"user" | "case" | "consultation">;
}

type DmmfField = Prisma.DMMF.Field;
type DmmfModel = Prisma.DMMF.Model;

const lowerFirst = (name: string) => name.charAt(0).toLowerCase() + name.slice(1);

function primaryKeyFields(model: DmmfModel): string[] {
  if (model.primaryKey?.fields?.length) return [...model.primaryKey.fields];
  return model.fields.filter((f) => f.isId).map((f) => f.name);
}

function relationsTo(model: DmmfModel, target: string): DmmfField[] {
  return model.fields.filter((f) => f.kind === "object" && f.type === target && (f.relationFromFields?.length ?? 0) > 0);
}

/** Works out, from the schema itself, which rows of which tables belong to a user. Because it
 * reads the schema, a table added later that points at a user (or at a case or consultation they
 * own) is included without anyone remembering to add it. */
export function planExport(userId: string): ExportSection[] {
  const sections: ExportSection[] = [];

  for (const model of Prisma.dmmf.datamodel.models) {
    if (model.name === "User" || EXPORT_EXCLUDED_MODELS.has(model.name)) continue;

    const conditions: Array<Record<string, unknown>> = [];
    const via: ExportSection["via"] = [];

    for (const rel of relationsTo(model, "User")) {
      for (const fk of rel.relationFromFields ?? []) conditions.push({ [fk]: userId });
      if (!via.includes("user")) via.push("user");
    }

    if (!ONLY_DIRECT.has(model.name)) {
      if (model.name !== "Case") {
        for (const rel of relationsTo(model, "Case")) {
          conditions.push({ [rel.name]: { userId } });
          if (!via.includes("case")) via.push("case");
        }
      }
      if (model.name !== "Consultation") {
        for (const rel of relationsTo(model, "Consultation")) {
          conditions.push({ [rel.name]: { userId } });
          if (!via.includes("consultation")) via.push("consultation");
        }
      }
    }

    if (conditions.length === 0) continue;

    sections.push({
      model: model.name,
      delegate: lowerFirst(model.name),
      where: conditions.length === 1 ? conditions[0]! : { OR: conditions },
      orderBy: primaryKeyFields(model).map((field) => ({ [field]: "asc" as const })),
      via,
    });
  }

  return sections;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !SECRET_KEY.test(key))
        .map(([key, v]) => [key, redact(v)]),
    );
  }
  return value;
}

/** JSON.stringify can't write a BigInt. */
const replacer = (_key: string, value: unknown) => (typeof value === "bigint" ? value.toString() : value);

type Delegate = {
  findMany: (args: { where: unknown; orderBy: unknown; skip?: number; take: number; cursor?: unknown }) => Promise<unknown[]>;
};

type Row = Record<string, unknown>;

/** The one-line description of a row for the readable report. Field names differ by table, so this
 * takes the first one that is present. The exact data is always in data.json. */
function rowLabel(model: string, row: Row): string {
  if (model === "Consent") return `${String(row.purpose)}: ${row.withdrawnAt ? "withdrawn" : "granted"}`;
  if (model === "OrganizationMember") return `Role: ${String(row.role)}`;
  for (const key of ["caseName", "name", "title", "filename", "fileName", "subject", "summary", "content", "purpose", "action"]) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim().replace(/\s+/g, " ").slice(0, 90);
  }
  return `(${model} ${String(row.id ?? "").slice(0, 8)})`;
}

const LISTED: Array<{ model: string; title: string }> = [
  { model: "Case", title: "Cases" },
  { model: "Document", title: "Documents" },
  { model: "Consultation", title: "Consultations" },
  { model: "Note", title: "Notes" },
  { model: "Event", title: "Calendar events" },
  { model: "Bookmark", title: "Bookmarks" },
  { model: "Organization", title: "Organizations you created" },
  { model: "OrganizationMember", title: "Organization memberships" },
  { model: "Consent", title: "Your consent choices" },
];

function whenOf(row: Row): string | undefined {
  const created = row.createdAt;
  return created instanceof Date ? created.toISOString().slice(0, 10) : undefined;
}

/** Keeps what the readable report needs while the rows stream past, without holding the rows. */
class ReportCollector {
  private readonly listings = new Map<string, ExportReportListing>(LISTED.map((l) => [l.model, { title: l.title, total: 0, shown: [] }]));
  private readonly activity: Array<{ label: string; at: Date }> = [];
  private activityTotal = 0;

  add(model: string, row: Row): void {
    const listing = this.listings.get(model);
    if (listing) {
      listing.total += 1;
      if (listing.shown.length < LISTING_LIMIT) listing.shown.push({ label: rowLabel(model, row), when: whenOf(row) });
    }
    if (model === "AuditEvent") {
      this.activityTotal += 1;
      const at = row.createdAt instanceof Date ? row.createdAt : new Date(0);
      if (this.activity.length < ACTIVITY_COLLECT_LIMIT) this.activity.push({ label: String(row.action), at });
    }
  }

  result(): ExportReportListing[] {
    const out = [...this.listings.values()];
    const newest = [...this.activity].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, LISTING_LIMIT);
    out.push({
      title: "Your recent activity",
      total: this.activityTotal,
      shown: newest.map((a) => ({ label: a.label, when: `${a.at.toISOString().replace("T", " ").slice(0, 16)} UTC` })),
    });
    return out;
  }
}

export interface ExportFileSource {
  open: (key: string) => Promise<{ body: Readable; contentLength?: number }>;
}

const s3FileSource: ExportFileSource = { open: getObjectStream };

export interface ZipExportResult {
  counts: Record<string, number>;
  filesIncluded: number;
  filesSkipped: number;
}

/** A name that is safe inside the archive: no folders, no control characters. */
function safeFileName(name: string | null, fallback: string): string {
  const cleaned = (name ?? "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return (cleaned || fallback).slice(0, 150);
}

export default class DataExportSvc {
  /** Writes one user's data as a single JSON document, a section at a time and BATCH_SIZE rows per
   * query, so a heavy user can't exhaust memory. `write` receives the pieces in order and may be
   * async (it is awaited, so a slow consumer slows the export down). Returns how many rows were
   * written per table. */
  static async stream(
    userId: string,
    write: (chunk: string) => void | Promise<void>,
    onRow?: (model: string, row: Row) => void,
  ): Promise<Record<string, number>> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return {};

    const counts: Record<string, number> = {};
    await write(`{"exportedAt":${JSON.stringify(new Date().toISOString())},"user":${JSON.stringify(redact(user), replacer)},"data":{`);

    const sections = planExport(userId);
    for (const [index, section] of sections.entries()) {
      const delegate = (prisma as unknown as Record<string, Delegate>)[section.delegate];
      await write(`${index === 0 ? "" : ","}${JSON.stringify(section.model)}:[`);

      let written = 0;
      for (let skip = 0; ; skip += BATCH_SIZE) {
        const rows = await delegate.findMany({ where: section.where, orderBy: section.orderBy, skip, take: BATCH_SIZE });
        for (const row of rows) {
          await write(`${written === 0 ? "" : ","}${JSON.stringify(redact(row), replacer)}`);
          onRow?.(section.model, row as Row);
          written += 1;
        }
        if (rows.length < BATCH_SIZE) break;
      }

      await write("]");
      counts[section.model] = written;
    }

    await write("}}");
    return counts;
  }

  /** The files this user is the owner of: their uploaded documents, brief exports, recordings and
   * avatar. Deleted files and files with no stored object are skipped. */
  private static async *userFiles(userId: string) {
    let cursor: string | undefined;
    for (;;) {
      const files = await prisma.file.findMany({
        where: {
          deletedAt: null,
          s3Key: { not: null },
          OR: [
            { users: { some: { id: userId } } },
            { caseDocuments: { some: { userId } } },
            { caseBriefExports: { some: { userId } } },
            { transcriptions: { some: { userId } } },
          ],
        },
        orderBy: { id: "asc" },
        take: BATCH_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      for (const file of files) yield file;
      if (files.length < BATCH_SIZE) return;
      cursor = files[files.length - 1]!.id;
    }
  }

  /** Streams the whole export as a ZIP: data.json (the complete record), files/ (the user's
   * uploaded files in their original form) and README.pdf (a readable summary). A file that can't
   * be read from storage is left out and named in the report; it never fails the export. */
  static async streamZip(userId: string, sink: ZipSink, files: ExportFileSource = s3FileSource): Promise<ZipExportResult> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return { counts: {}, filesIncluded: 0, filesSkipped: 0 };

    const zip = new ZipWriter(sink);
    const collector = new ReportCollector();

    const json = await zip.startEntry("data.json");
    const counts = await DataExportSvc.stream(userId, (chunk) => json.write(chunk), (model, row) => collector.add(model, row));
    await json.end();

    const included: Array<{ path: string }> = [];
    const skipped: Array<{ name: string; reason: string }> = [];
    for await (const file of DataExportSvc.userFiles(userId)) {
      const label = toWinAnsi(file.filename ?? file.id);
      if (included.length >= MAX_FILE_ENTRIES) {
        skipped.push({ name: label, reason: "the archive is full; ask us for the remaining files" });
        continue;
      }
      try {
        const source = await files.open(file.s3Key!);
        if (source.contentLength !== undefined && source.contentLength > MAX_FILE_BYTES) {
          source.body.destroy();
          skipped.push({ name: label, reason: "larger than the 4 GB limit of this download" });
          continue;
        }
        const path = `files/${file.id.slice(0, 8)}-${safeFileName(file.filename, file.id)}`;
        const entry = await zip.startEntry(path, file.createdAt);
        for await (const chunk of source.body) await entry.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        await entry.end();
        included.push({ path });
      } catch (err) {
        // If the failure happened mid-file, the open entry is unusable and so is the archive.
        if (err instanceof Error && /ZIP/.test(err.message)) throw err;
        skipped.push({ name: label, reason: "could not be read from storage" });
      }
    }

    const nonEmpty = Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));
    const report = await renderDataExportReport({
      generatedAt: new Date(),
      account: { name: user.name, email: user.email, username: user.username, createdAt: user.createdAt },
      counts: nonEmpty,
      listings: collector.result(),
      files: { included, skipped },
    });
    await zip.addBuffer("README.pdf", report);
    await zip.finish();

    return { counts, filesIncluded: included.length, filesSkipped: skipped.length };
  }
}
