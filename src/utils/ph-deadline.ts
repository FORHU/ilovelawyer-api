import { PH_DEADLINE_RULES, PH_FIXED_HOLIDAYS, PH_VARIABLE_HOLIDAYS, DeadlineRule } from "../constants/ph-holidays.constants";

export interface DeadlineComputation {
  rule: DeadlineRule;
  triggerDate: Date;
  computedDueDate: Date;
  calculationNotes: string;
}

function ymd(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

export function isPhilippineHoliday(date: Date): { holiday: boolean; name?: string } {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();

  const fixed = PH_FIXED_HOLIDAYS.find((h) => h.month === month && h.day === day);
  if (fixed) return { holiday: true, name: fixed.name };

  const variable = (PH_VARIABLE_HOLIDAYS[year] ?? []).find((h) => h.month === month && h.day === day);
  if (variable) return { holiday: true, name: variable.name };

  return { holiday: false };
}

export function isNonWorkingDay(date: Date): { skip: boolean; reason?: string } {
  const dow = date.getUTCDay();
  if (dow === 0) return { skip: true, reason: "Sunday" };
  if (dow === 6) return { skip: true, reason: "Saturday" };
  const holiday = isPhilippineHoliday(date);
  if (holiday.holiday) return { skip: true, reason: holiday.name };
  return { skip: false };
}

function addUtcDays(date: Date, days: number): Date {
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function nextWorkingDay(date: Date): { date: Date; rolled: string[] } {
  const rolled: string[] = [];
  let cursor = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  for (let i = 0; i < 14; i++) {
    const check = isNonWorkingDay(cursor);
    if (!check.skip) return { date: cursor, rolled };
    rolled.push(`${ymd(cursor)} (${check.reason})`);
    cursor = addUtcDays(cursor, 1);
  }
  return { date: cursor, rolled };
}

export function getDeadlineRule(code: string): DeadlineRule | undefined {
  return PH_DEADLINE_RULES.find((r) => r.code === code);
}

export function listDeadlineRules(): DeadlineRule[] {
  return PH_DEADLINE_RULES;
}

/**
 * Rules of Court, Rule 22: exclude the trigger day, include the last day;
 * if the last day is Saturday, Sunday, or a legal holiday, run to the next working day.
 * This function never uses an LLM.
 */
export function computePhilippineDeadline(ruleCode: string, triggerDate: Date): DeadlineComputation {
  const rule = getDeadlineRule(ruleCode);
  if (!rule) throw new Error(`Unknown deadline rule: ${ruleCode}`);

  const start = new Date(Date.UTC(triggerDate.getUTCFullYear(), triggerDate.getUTCMonth(), triggerDate.getUTCDate()));
  const rawDue = addUtcDays(start, rule.days);
  const { date: due, rolled } = nextWorkingDay(rawDue);

  const notes = [
    `Trigger date (excluded under Rule 22): ${ymd(start)}`,
    `Period: ${rule.days} days under ${rule.ruleSource}`,
    `Raw last day: ${ymd(rawDue)}`,
    rolled.length > 0
      ? `Rolled forward because last day fell on non-working day(s): ${rolled.join(", ")}`
      : "Last day is a working day; no weekend/holiday roll-forward",
    `Computed due date: ${ymd(due)}`,
    "This date is a machine calculation. Two attorney confirmations are required before it is treated as a filing deadline.",
  ].join("\n");

  return { rule, triggerDate: start, computedDueDate: due, calculationNotes: notes };
}
