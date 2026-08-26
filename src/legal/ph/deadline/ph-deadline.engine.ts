import { DeadlineEngine, DeadlineResult, DeadlineRuleSummary } from "../../types";
import { computePhilippineDeadline, listDeadlineRules } from "../../../utils/ph-deadline";
import HttpError from "../../../utils/http-error";

/** Thin adapter over the existing, unchanged PH deadline math in utils/ph-deadline.ts —
 * zero regression risk, logic untouched. */
export class PHDeadlineEngine implements DeadlineEngine {
  readonly jurisdiction = "PH" as const;

  listRules(): DeadlineRuleSummary[] {
    return listDeadlineRules();
  }

  calculate(ruleCode: string, triggerDate: Date): DeadlineResult {
    try {
      const computation = computePhilippineDeadline(ruleCode, triggerDate);
      return {
        rule: computation.rule,
        triggerDate: computation.triggerDate,
        computedDueDate: computation.computedDueDate,
        calculationNotes: computation.calculationNotes,
      };
    } catch (err) {
      throw new HttpError((err as Error).message, 400);
    }
  }
}
