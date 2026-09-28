/**
 * The case data a Jev pilot judges an item against — the same lists for every panel (Red Team,
 * and the Legal Issues / Weaknesses / Strengths checks), formatted the same way so a benchmark
 * run for one pilot reads the case the way the others do.
 */
export interface CaseJevContext {
  opponent: string | null;
  legalIssues: string[];
  weaknesses: string[];
  contradictions: string[];
  timeline: string[];
  witnesses: string[];
  parties: string[];
}

// Enough to judge against, without resending a long timeline for each of up to eight items.
export const MAX_CONTEXT_ITEMS = 25;

export function formatContradiction(c: { leftExcerpt: string; rightExcerpt: string }): string {
  return `"${c.leftExcerpt}" vs "${c.rightExcerpt}"`;
}

export function formatTimelineEntry(t: { title: string; occurredOn?: Date | string | null }): string {
  const d = t.occurredOn ? new Date(t.occurredOn) : null;
  return `${d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : "undated"} — ${t.title}`;
}

export function formatWitness(w: { name: string; role?: string | null }): string {
  return w.role ? `${w.name} (${w.role})` : w.name;
}

export function formatParty(p: { name: string; designation: string }): string {
  return `${p.name} (${p.designation})`;
}

/** The `caseData` block of a Jev request, each list capped at MAX_CONTEXT_ITEMS. */
export function caseDataState(context: CaseJevContext) {
  const clip = (items: string[]) => items.slice(0, MAX_CONTEXT_ITEMS);
  return {
    parties: clip(context.parties),
    legalIssues: clip(context.legalIssues),
    weaknesses: clip(context.weaknesses),
    contradictions: clip(context.contradictions),
    timeline: clip(context.timeline),
    witnesses: clip(context.witnesses),
  };
}
