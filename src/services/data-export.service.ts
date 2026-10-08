import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";

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
  findMany: (args: { where: unknown; orderBy: unknown; skip: number; take: number }) => Promise<unknown[]>;
};

export default class DataExportSvc {
  /** Writes one user's data as a single JSON document, a section at a time and BATCH_SIZE rows per
   * query, so a heavy user can't exhaust memory. `write` receives the pieces in order. Returns how
   * many rows were written per table. Original file bytes are not included, only their records. */
  static async stream(userId: string, write: (chunk: string) => void): Promise<Record<string, number>> {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return {};

    const counts: Record<string, number> = {};
    write(`{"exportedAt":${JSON.stringify(new Date().toISOString())},"user":${JSON.stringify(redact(user), replacer)},"data":{`);

    const sections = planExport(userId);
    for (const [index, section] of sections.entries()) {
      const delegate = (prisma as unknown as Record<string, Delegate>)[section.delegate];
      write(`${index === 0 ? "" : ","}${JSON.stringify(section.model)}:[`);

      let written = 0;
      for (let skip = 0; ; skip += BATCH_SIZE) {
        const rows = await delegate.findMany({ where: section.where, orderBy: section.orderBy, skip, take: BATCH_SIZE });
        for (const row of rows) {
          write(`${written === 0 ? "" : ","}${JSON.stringify(redact(row), replacer)}`);
          written += 1;
        }
        if (rows.length < BATCH_SIZE) break;
      }

      write("]");
      counts[section.model] = written;
    }

    write("}}");
    return counts;
  }
}
