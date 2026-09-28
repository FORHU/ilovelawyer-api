import { judgeMindMapPoint, type MindMapJevContext, type SupportVerdict } from "./mind-map-jev";
import logger from "./logger";

/**
 * Jev as the verifier behind the Case Strategy panel's recommended approach, the same way it
 * verifies the case mind map's points (mind-map-jev.ts): CaseStrategySvc writes the plan; Jev then
 * judges each recommended-approach item against the case data (findings, key dates,
 * contradictions, witnesses, parties, damages) — SUPPORTED / UNSUPPORTED / CONTRADICTED — and the
 * verdict is stored on the item and shown to the lawyer, never used to change the plan.
 *
 * Only STRATEGY items are judged. To-dos are actions ("Subpoena the HR email thread"), not
 * statements about the case, so nothing in the case data can bear them out and every one would
 * come back UNSUPPORTED for no reason — the same reason the mind map skips its Next Steps branch.
 *
 * Off unless USE_JEV_CASE_STRATEGY=true.
 */
export function isCaseStrategyJevEnabled(): boolean {
  return process.env.USE_JEV_CASE_STRATEGY === "true";
}

/** Recommended-approach items checked per run — a plan is a handful of moves, not hundreds. */
export const CASE_STRATEGY_JEV_MAX_ITEMS = 40;
const CONCURRENCY = 5;
const BRANCH_LABEL = "Recommended approach";

export interface StrategyItemCheck {
  verdict: SupportVerdict;
  confidence: number;
  checkedAt: string;
}

export interface StrategyItemToCheck {
  id: string;
  label: string;
}

export interface StrategyCheckResult {
  id: string;
  /** The exact text Jev judged, so a verdict is only attached to a row that still says it. */
  label: string;
  check: StrategyItemCheck;
}

/** Judges `items` CONCURRENCY at a time. A Jev failure leaves that item unchecked and logged —
 * "we couldn't check" must not read as a verdict. */
export async function checkStrategyItems(items: StrategyItemToCheck[], context: MindMapJevContext): Promise<StrategyCheckResult[]> {
  const queue = items.slice(0, CASE_STRATEGY_JEV_MAX_ITEMS);
  const results: StrategyCheckResult[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        const item = queue[next++];
        if (!item) return;
        try {
          logger.info("Jev request", { feature: "case-strategy", itemId: item.id });
          const judged = await judgeMindMapPoint({ branch: BRANCH_LABEL, text: item.label }, context);
          logger.info("Jev response", {
            feature: "case-strategy",
            itemId: item.id,
            verdict: judged.verdict,
            confidence: judged.confidence,
            rawVerdict: judged.rawVerdict,
            downgraded: judged.downgraded,
          });
          results.push({
            id: item.id,
            label: item.label,
            check: { verdict: judged.verdict, confidence: judged.confidence, checkedAt: new Date().toISOString() },
          });
        } catch (err) {
          logger.warn("Case strategy Jev check failed, leaving the item unchecked", { err, itemId: item.id });
        }
      }
    }),
  );
  return results;
}
