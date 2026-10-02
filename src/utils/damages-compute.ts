import type { TenantCode } from "../types/tenant-code";

/**
 * The Damages & Remedies totals — the one place they are worked out, so the panel, Red Team and
 * chat all read the same numbers. Pure (no DB, no LLM). Only accepted entries count; an AI
 * proposal waiting for a lawyer is left out until it is accepted.
 */

export const DAMAGE_KINDS = ["DAMAGE", "REMEDY"] as const;
export type DamageKindValue = (typeof DAMAGE_KINDS)[number];

export interface DamageEntryInput {
  kind: DamageKindValue;
  amount: number | null;
  done: boolean;
  accepted: boolean;
}

export interface DamagesSummary {
  currency: "PHP" | "GBP";
  /** Sum of every accepted entry's amount. */
  total: number;
  /** The part of `total` already awarded or received. */
  awarded: number;
  /** Accepted entries, then how many of them are damages and remedies. */
  headCount: number;
  damageCount: number;
  remedyCount: number;
  /** Accepted entries marked awarded or received. */
  doneCount: number;
}

export function currencyForTenant(tenantCode: TenantCode | null | undefined): "PHP" | "GBP" {
  return tenantCode === "UK" ? "GBP" : "PHP";
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function computeDamagesSummary(entries: DamageEntryInput[], tenantCode?: TenantCode | null): DamagesSummary {
  const accepted = entries.filter((e) => e.accepted);
  const sum = (rows: DamageEntryInput[]) => round2(rows.reduce((acc, e) => acc + (e.amount ?? 0), 0));
  return {
    currency: currencyForTenant(tenantCode),
    total: sum(accepted),
    awarded: sum(accepted.filter((e) => e.done)),
    headCount: accepted.length,
    damageCount: accepted.filter((e) => e.kind === "DAMAGE").length,
    remedyCount: accepted.filter((e) => e.kind === "REMEDY").length,
    doneCount: accepted.filter((e) => e.done).length,
  };
}

export interface DamagePromptHead {
  kind: string;
  title: string;
  description?: string | null;
  amount?: number | null;
  done?: boolean;
  dueDate?: string | Date | null;
}

function isoDay(value: string | Date): string | null {
  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/** One entry as a line of plain text for prompts (Red Team, chat), e.g.
 * "DAMAGE (Backwages): 486000 — unpaid wages since dismissal [not yet awarded; due 2026-11-15]".
 * The description stays verbatim and in the same place, since Red Team's [ARGUMENTS] cite it as a source. */
export function formatDamageForPrompt(d: DamagePromptHead): string {
  const details: string[] = [d.done ? "awarded or received" : "not yet awarded"];
  const due = d.dueDate ? isoDay(d.dueDate) : null;
  if (due) details.push(`due ${due}`);
  return (
    `${d.kind} (${d.title})` +
    `${d.amount != null ? `: ${d.amount}` : ""}` +
    `${d.description ? ` — ${d.description}` : ""}` +
    ` [${details.join("; ")}]`
  );
}
