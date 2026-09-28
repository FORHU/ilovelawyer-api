/** Audit actions that change what the Case Strategy panel is built from (documents, findings,
 * dated events, evidence, witnesses, damages, claims, law). Anything else — the panel's own
 * checklist/risk/deadline edits, mind-map work — is not the case moving on without it. */
const STRATEGY_INPUT_PREFIXES = [
  "document.",
  "timeline.create",
  "finding.",
  "evidence.",
  "witness.",
  "damage.",
  "claim.",
  "authority.",
  "citation.",
  "decision.",
];

export const STRATEGY_GENERATED_ACTION = "strategy.generate";

export function isStrategyInputAction(action: string): boolean {
  return STRATEGY_INPUT_PREFIXES.some((prefix) => action.startsWith(prefix));
}

export interface StrategyAuditRow {
  action: string;
  createdAt: Date;
}

/**
 * The Case Strategy panel is stale when the case changed underneath it after it was last
 * generated, so the lawyer is told to refresh instead of trusting an outdated plan. `changedSince`
 * is how many such changes there are, for the "N changes since" hint. Never stale before the first
 * generation (that's the empty-state Generate CTA's job) — same rule as the mind map.
 */
export function strategyStaleness(audit: StrategyAuditRow[]): {
  lastGeneratedAt: Date | null;
  isStale: boolean;
  changedSince: number;
} {
  const lastGeneratedAt = audit
    .filter((row) => row.action === STRATEGY_GENERATED_ACTION)
    .reduce<Date | null>((latest, row) => (!latest || row.createdAt > latest ? row.createdAt : latest), null);
  if (!lastGeneratedAt) return { lastGeneratedAt: null, isStale: false, changedSince: 0 };
  const changedSince = audit.filter((row) => isStrategyInputAction(row.action) && row.createdAt > lastGeneratedAt).length;
  return { lastGeneratedAt, isStale: changedSince > 0, changedSince };
}
