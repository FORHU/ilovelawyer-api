import { FACTOR_DEFINITIONS, FACTOR_KEYS, RUBRIC, RUBRIC_VERSION, scoreWitness, type FactorAnswers, type FactorKey } from "./witness-rubric";
import { buildNeeds, type WitnessNeed } from "./witness-needs";
import type { FactorAudit, FactorOverrides } from "./witness-factor-resolve";
import { parseOverrides } from "./witness-factor-resolve";

/** The shape written to Witness.aiFactors by scoring and by a recompute. */
export interface StoredFactors {
  factors: Record<FactorKey, FactorAudit>;
  earned: number;
  assessable: number;
  band: string | null;
  flags: string[];
  insufficientReason: string | null;
  needs: WitnessNeed[];
  aiNeeds?: Partial<Record<FactorKey, string>>;
  sponsoredDocumentCount?: number;
  reviewCount?: number;
  /** The lawyer's own answers in plain words, for the panel's "set by you" list. */
  overrideList?: OverrideView[];
}

export interface OverrideView {
  factor: FactorKey;
  label: string;
  answerLabel: string;
  note: string;
  at: string;
}

export function describeOverrides(overrides: FactorOverrides | null): OverrideView[] {
  const out: OverrideView[] = [];
  for (const factor of FACTOR_KEYS) {
    const o = overrides?.[factor];
    if (!o?.answer) continue;
    out.push({
      factor,
      label: RUBRIC[factor].label,
      answerLabel: FACTOR_DEFINITIONS[factor].options[o.answer] ?? o.answer,
      note: o.note,
      at: o.at,
    });
  }
  return out;
}

export function parseStoredFactors(raw: unknown): StoredFactors | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!r.factors || typeof r.factors !== "object") return null;
  return r as unknown as StoredFactors;
}

/** The app's own next steps, recovered from stored needs for rows scored before they were kept. */
function recoverAiNeeds(stored: StoredFactors): Partial<Record<FactorKey, string>> {
  if (stored.aiNeeds) return stored.aiNeeds;
  const out: Partial<Record<FactorKey, string>> = {};
  for (const n of stored.needs ?? []) if (n.factor) out[n.factor] = n.text;
  return out;
}

/**
 * Rebuilds the score, band, flags, suggested status and needs from the stored classifier answers plus
 * a lawyer's overrides, without calling any model. The classifier's own answers stay in
 * `factors[k].answer`; an override only sets `overriddenTo`, so clearing it restores the original.
 */
export function recomputeFromStored(
  stored: StoredFactors,
  overridesRaw: unknown,
  statementReceived: boolean,
): { aiCredibility: number | null; aiSuggestedStatus: "READY" | "ADVERSE" | "OUTSTANDING"; aiFactors: StoredFactors; overrides: FactorOverrides | null } {
  const overrides = parseOverrides(overridesRaw);
  const factors = {} as Record<FactorKey, FactorAudit>;
  const answers: FactorAnswers = {};
  for (const key of FACTOR_KEYS) {
    const entry = { ...stored.factors[key] };
    delete entry.overriddenTo;
    const override = overrides?.[key];
    const overrideAnswer = override?.answer ?? null;
    answers[key] = overrideAnswer ?? entry.answer ?? null;
    if (overrideAnswer) entry.overriddenTo = overrideAnswer;
    factors[key] = entry;
  }
  const rubric = scoreWitness(answers, statementReceived);
  const sponsoredDocumentCount =
    stored.sponsoredDocumentCount ?? ((stored.needs ?? []).some((n) => n.key === "DOCUMENT") ? 0 : 1);
  const aiNeeds = recoverAiNeeds(stored);
  const unsure = Object.fromEntries(FACTOR_KEYS.map((k) => [k, !!factors[k].lowConfidence && !factors[k].overriddenTo]));
  const needs = buildNeeds({ statementReceived, sponsoredDocumentCount, answers, aiNeeds, unsure });
  return {
    aiCredibility: rubric.score,
    aiSuggestedStatus: rubric.suggestedStatus,
    overrides,
    aiFactors: {
      ...stored,
      factors,
      earned: rubric.earned,
      assessable: rubric.assessable,
      band: rubric.band,
      flags: rubric.flags,
      insufficientReason: rubric.insufficientReason,
      needs,
      aiNeeds,
      sponsoredDocumentCount,
      reviewCount: FACTOR_KEYS.filter((k) => factors[k].lowConfidence && !factors[k].overriddenTo).length,
      overrideList: describeOverrides(overrides),
    },
  };
}

export { RUBRIC_VERSION };
