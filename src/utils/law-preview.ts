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
> &
  Partial<Pick<Law, "category" | "sections">>;

/** A UK judgment's detail fill stores its paragraphs as `sections: [{ title: eId, summary:
 * preview }]` and nothing in summary/facts/fullText, so its opening paragraph is the only text a
 * preview can show. Judgments only — legislation `sections` are a TOC (`summary` is a section id). */
function firstParagraphPreview(row: PreviewRow): string | null {
  if (row.category !== "JURISPRUDENCE" || !Array.isArray(row.sections)) return null;
  for (const s of row.sections) {
    const summary = (s as { summary?: unknown } | null)?.summary;
    if (typeof summary === "string" && summary.trim()) return summary;
  }
  return null;
}

/** Collapses whitespace and cuts `text` to at most `max` chars at the last word boundary,
 * appending an ellipsis when anything was dropped. */
export function truncateAtWord(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

/** legislation.gov.uk renders a repealed section's text (and heading) as a run of ". . . ." dot
 * leaders — once those are stripped, a repealed entry has no letters left at all. */
const DOT_LEADERS = /(?:\.\s*){3,}/g;

/** A UK key provision is stored as `"<heading>: <heading> <section no.> [<subsection no.>] . . . <text>"`
 * — drop the repeated heading, the section/subsection numbers and dot leaders so the card opens on the provision's text.
 * Anything else passes through with only its dot leaders collapsed. */
function cleanSnippetSource(text: string): string {
  const withoutDots = text.replace(DOT_LEADERS, " ").replace(/\s+/g, " ").trim();
  const sep = withoutDots.indexOf(": ");
  if (sep > 0) {
    const heading = withoutDots.slice(0, sep);
    const rest = withoutDots.slice(sep + 2);
    if (rest.startsWith(heading)) {
      // Section number, then often a subsection number too ("1 1 If any person…").
      return rest.slice(heading.length).replace(/^(?:\s*\d+[A-Z]*\b)+\s*/, "").trim();
    }
  }
  return withoutDots;
}

function isMeaningful(text: string): boolean {
  return /\p{L}/u.test(text);
}

/** A stored Law row → its hover preview. The snippet is the first non-empty of: summary
 * (republic acts), disposition, facts (jurisprudence), the first key provision, the start of
 * the full text — `fullText` only if an earlier detail-page view already extracted it — or a UK
 * judgment's first paragraph (firstParagraphPreview). */
export function toLawPreview(row: PreviewRow): LawPreview {
  // Every key provision, not just the first — a UK Act's opening sections are often repealed
  // (all dot leaders), and the first one with real text is the useful one.
  const source = [row.summary, row.disposition, row.facts, ...row.keyProvisions, row.fullText, firstParagraphPreview(row)]
    .map((s) => (s ? cleanSnippetSource(s) : ""))
    .find(isMeaningful);
  return {
    title: row.title,
    reference: row.caseNumber ?? row.raNumber ?? null,
    year: row.year,
    court: row.division,
    snippet: source ? truncateAtWord(source, PREVIEW_SNIPPET_MAX) : null,
  };
}
