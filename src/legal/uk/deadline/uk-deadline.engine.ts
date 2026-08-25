import { DeadlineEngine, DeadlineResult, DeadlineRuleSummary } from "../../types";
import { UK_VARIABLE_HOLIDAYS, UK_DEADLINE_RULES, UKDeadlineRule } from "./uk-holidays.constants";
import HttpError from "../../../utils/http-error";

function ymd(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function isEnglandWalesBankHoliday(date: Date): { holiday: boolean; name?: string } {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const match = (UK_VARIABLE_HOLIDAYS[year] ?? []).find((h) => h.month === month && h.day === day);
  return match ? { holiday: true, name: match.name } : { holiday: false };
}

function isNonWorkingDay(date: Date): { skip: boolean; reason?: string } {
  const dow = date.getUTCDay();
  if (dow === 0) return { skip: true, reason: "Sunday" };
  if (dow === 6) return { skip: true, reason: "Saturday" };
  const holiday = isEnglandWalesBankHoliday(date);
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

function getRule(code: string): UKDeadlineRule | undefined {
  return UK_DEADLINE_RULES.find((r) => r.code === code);
}

/**
 * LEGAL_REVIEW_REQUIRED: England & Wales only (Scotland/Northern Ireland out of scope —
 * see uk-holidays.constants.ts). Provisional CPR-period rule set, not yet validated by a
 * UK-qualified lawyer. Mirrors the PH engine's date-math shape (exclude trigger day, add the
 * rule's period, roll forward over weekends/bank holidays) as a reasonable general-purpose
 * approximation for this engineering scaffold — it is not a certified implementation of CPR
 * 2.8's "clear days" counting rules and must not be treated as one until reviewed.
 */
export class UKDeadlineEngine implements DeadlineEngine {
  readonly jurisdiction = "UK" as const;

  listRules(): DeadlineRuleSummary[] {
    return UK_DEADLINE_RULES;
  }

  calculate(ruleCode: string, triggerDate: Date): DeadlineResult {
    const rule = getRule(ruleCode);
    if (!rule) {
      throw new HttpError(
        `Unknown UK deadline rule: ${ruleCode}. UK procedural deadlines are provisional and LEGAL_REVIEW_REQUIRED — this rule has not been configured.`,
        400,
      );
    }

    const start = new Date(Date.UTC(triggerDate.getUTCFullYear(), triggerDate.getUTCMonth(), triggerDate.getUTCDate()));
    const rawDue = addUtcDays(start, rule.days);
    const { date: due, rolled } = nextWorkingDay(rawDue);

    const notes = [
      `Trigger date (excluded): ${ymd(start)}`,
      `Period: ${rule.days} days under ${rule.ruleSource}`,
      `Raw last day: ${ymd(rawDue)}`,
      rolled.length > 0
        ? `Rolled forward because last day fell on non-working day(s): ${rolled.join(", ")}`
        : "Last day is a working day; no weekend/bank-holiday roll-forward",
      `Computed due date: ${ymd(due)}`,
      "LEGAL_REVIEW_REQUIRED: this is a provisional, England & Wales-only machine calculation " +
        "and has not been validated by a UK-qualified lawyer. Two attorney confirmations are " +
        "required before it is treated as a filing deadline.",
    ].join("\n");

    return { rule, triggerDate: start, computedDueDate: due, calculationNotes: notes };
  }
}
