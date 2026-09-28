/**
 * The small pieces every Jev pilot repeats around a systemOne response: reading a Choice back
 * into a known verdict, putting a confidence floor under the one verdict that would talk a
 * lawyer out of something, and normalizing a Score to 0..1. Each pilot still owns its own
 * questions, levels and floors — only the mechanics live here.
 */

/** Below this a Score's confidence is spread across levels; panels mark the rating as uncertain
 * rather than presenting it as settled. Provisional — set per pilot from its benchmark. */
export const UNCERTAIN_SCORE_CONFIDENCE = 0.5;

/** Jev's Choice answer as one of `allowed`, or `fallback` when it answered something else. */
export function readChoice<T extends string>(choice: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(choice) ? (choice as T) : fallback;
}

/**
 * `guarded` is the verdict a pilot will only report with at least `floor` confidence (e.g.
 * CONTRADICTED, NOT_A_CONFLICT); under it the answer becomes `fallback`. `downgraded` is returned
 * so the pilot can log it — a floor-triggered fallback must stay visible in the trace.
 */
export function applyFloor<T extends string>(
  raw: T,
  confidence: number,
  guarded: T,
  floor: number,
  fallback: T,
): { value: T; downgraded: boolean } {
  const downgraded = raw === guarded && confidence < floor;
  return { value: downgraded ? fallback : raw, downgraded };
}

/** A Score answer's level as 0..1, where 1 is the top of `levels`. */
export function normalizeScore(score: number, levels: readonly unknown[]): number {
  const top = levels.length - 1;
  return top > 0 ? Math.max(0, Math.min(1, score / top)) : 0;
}

export function isUncertain(...confidences: number[]): boolean {
  return confidences.some((c) => c < UNCERTAIN_SCORE_CONFIDENCE);
}
