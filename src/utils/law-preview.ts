import { Law } from "@prisma/client";

/** GET /api/law/preview's response — the handful of fields the chat's citation hover card shows.
 * Deliberately small: the card opens on hover, so it must never carry `fullText` or anything
 * else /api/law/document returns in bulk. */
export interface LawPreview {
  title: string;
  reference: string | null;
  year: number | null;
  court: string | null;
  snippet: string | null;
}

export const PREVIEW_SNIPPET_MAX = 280;

type PreviewRow = Pick<
  Law,
  "title" | "caseNumber" | "raNumber" | "year" | "division" | "summary" | "disposition" | "facts" | "keyProvisions" | "fullText"
>;

/** Collapses whitespace and cuts `text` to at most `max` chars at the last word boundary,
 * appending an ellipsis when anything was dropped. */
export function truncateAtWord(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

/** A stored Law row → its hover preview. The snippet is the first non-empty of: summary
 * (republic acts), disposition, facts (jurisprudence), the first key provision, or the start of
 * the full text — `fullText` only if an earlier detail-page view already extracted it; the
 * preview path never triggers extraction itself. */
export function toLawPreview(row: PreviewRow): LawPreview {
  const source = [row.summary, row.disposition, row.facts, row.keyProvisions[0], row.fullText].find(
    (s): s is string => !!s && s.trim().length > 0,
  );
  return {
    title: row.title,
    reference: row.caseNumber ?? row.raNumber ?? null,
    year: row.year,
    court: row.division,
    snippet: source ? truncateAtWord(source, PREVIEW_SNIPPET_MAX) : null,
  };
}
