import { ManualEditChange, ManualEditValue } from "../types/manual-edit";

/** How a field is recorded: "value" keeps from/to (a tag, status, amount, date); "text" only names
 * the field (a detail, note or narrative — too long to copy into the log). */
export type FieldKind = "value" | "text";

const ISO_DAY = /^\d{4}-\d{2}-\d{2}(T.*)?$/;

/** A value as the log stores it: dates as YYYY-MM-DD, trimmed strings, empty as null. Anything
 * that isn't a plain value (an object, a list) reads as null. */
export function normalizeEditValue(value: unknown): ManualEditValue {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return ISO_DAY.test(trimmed) && !Number.isNaN(Date.parse(trimmed)) ? trimmed.slice(0, 10) : trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  return null;
}

/** The fields `patch` actually changes on `before`, among `fields`. A field the patch doesn't send
 * (undefined) is left out; so is one sent with the value it already had. */
export function fieldChanges(
  before: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown>,
  fields: Record<string, FieldKind>,
): ManualEditChange[] {
  const out: ManualEditChange[] = [];
  for (const [field, kind] of Object.entries(fields)) {
    if (patch[field] === undefined) continue;
    const from = normalizeEditValue(before?.[field]);
    const to = normalizeEditValue(patch[field]);
    if (from === to) continue;
    out.push(kind === "text" ? { field } : { field, from, to });
  }
  return out;
}

/** Folds `next` into `previous` (the same item's earlier edit): each field keeps its first `from`
 * and takes the latest `to`, and a field that ended up back where it started drops out. */
export function mergeEditChanges(previous: ManualEditChange[], next: ManualEditChange[]): ManualEditChange[] {
  const merged = new Map(previous.map((c) => [c.field, { ...c }]));
  for (const change of next) {
    const was = merged.get(change.field);
    if (!was) merged.set(change.field, { ...change });
    else if ("to" in change) merged.set(change.field, { ...was, to: change.to });
  }
  return [...merged.values()].filter((c) => !("from" in c) || c.from !== c.to);
}
