import { TenantCode } from "../types/tenant-code";

export interface DeadlineRuleSummary {
  code: string;
  label: string;
  days: number;
  ruleSource: string;
}

export interface DeadlineResult {
  rule: DeadlineRuleSummary;
  triggerDate: Date;
  computedDueDate: Date;
  calculationNotes: string;
}

/**
 * One tenantCode's procedural-deadline calculator. Selected by tenantCode only (see
 * legal/deadline-engine.registry.ts) — never by client input. Implementations never call an
 * LLM; this is pure date/calendar-rule math with a human-readable audit trail.
 */
export interface DeadlineEngine {
  readonly tenantCode: TenantCode;
  listRules(): DeadlineRuleSummary[];
  calculate(ruleCode: string, triggerDate: Date): DeadlineResult;
}
