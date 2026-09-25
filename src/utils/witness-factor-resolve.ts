import { FACTOR_KEYS, RUBRIC, type FactorAnswers, type FactorKey } from "./witness-rubric";
import type { WitnessFactorAnswer } from "./witness-scoring-parse";
import type { JevFactors } from "./witness-rubric-jev";

export type FactorSource = "OVERRIDE" | "JEV" | "AI" | "NONE";

/** Stored per factor in Witness.aiFactors — everything needed to explain a score afterwards. */
export interface FactorAudit {
  answer: string | null;
  by: FactorSource;
  /** Jev's confidence when Jev answered; null otherwise. */
  confidence: number | null;
  quote: string | null;
  quoteVerified: boolean;
  documentName: string | null;
  /** What Chat Wonder answered, kept when it differs from the final answer. */
  aiAnswer?: string | null;
  /** Jev's answer before the confidence floor, kept when the floor dropped it. */
  jevRawAnswer?: string | null;
}

export interface FactorOverride {
  answer: string | null;
  note: string;
  by: string;
  at: string;
}

export type FactorOverrides = Partial<Record<FactorKey, FactorOverride>>;

export interface QuoteCheck {
  verified: boolean;
  /** The document the quote was found in, when it was. */
  documentName: string | null;
}

function validOption(key: FactorKey, value: string | null | undefined): string | null {
  return value && Object.prototype.hasOwnProperty.call(RUBRIC[key].options, value) ? value : null;
}

/**
 * Final answer per factor. Precedence: a lawyer's override, then Jev (when it ran and cleared its
 * confidence floor), then Chat Wonder's answer — and Chat Wonder's answer only counts if its quote
 * was found in the source text. A Jev answer stands without a quote, since Jev read the same text;
 * a Chat Wonder answer has nothing else to stand on. Anything left over is not assessable (null).
 */
export function resolveFactors(
  ai: Record<FactorKey, WitnessFactorAnswer>,
  jev: JevFactors | null,
  overrides: FactorOverrides | null,
  checkQuote: (quote: string) => QuoteCheck,
): { answers: FactorAnswers; audit: Record<FactorKey, FactorAudit> } {
  const answers: FactorAnswers = {};
  const audit = {} as Record<FactorKey, FactorAudit>;

  for (const key of FACTOR_KEYS) {
    const cw = ai[key];
    const check = cw.quote ? checkQuote(cw.quote) : { verified: false, documentName: null };
    const cwAnswer = validOption(key, cw.answer);
    const cwCounts = cwAnswer !== null && check.verified;
    const evidence = {
      quote: cw.quote,
      quoteVerified: check.verified,
      documentName: check.verified ? check.documentName ?? cw.document : cw.document,
    };

    const override = overrides?.[key];
    if (override) {
      const answer = validOption(key, override.answer);
      answers[key] = answer;
      audit[key] = { answer, by: "OVERRIDE", confidence: null, ...evidence, aiAnswer: cw.answer };
      continue;
    }

    const jevAnswer = jev ? jev[key] : null;
    if (jevAnswer && jevAnswer.answer) {
      answers[key] = jevAnswer.answer;
      audit[key] = {
        answer: jevAnswer.answer,
        by: "JEV",
        confidence: jevAnswer.confidence,
        ...evidence,
        ...(cwAnswer !== jevAnswer.answer ? { aiAnswer: cw.answer } : {}),
      };
      continue;
    }

    // Jev ran but was unsure or said NOT_SHOWN: that is the answer. Falling back to Chat Wonder here
    // would put back the unstable impression Jev was brought in to remove.
    if (jev) {
      answers[key] = null;
      audit[key] = {
        answer: null,
        by: "NONE",
        confidence: jevAnswer?.confidence ?? null,
        ...evidence,
        aiAnswer: cw.answer,
        jevRawAnswer: jevAnswer?.rawAnswer ?? null,
      };
      continue;
    }

    answers[key] = cwCounts ? cwAnswer : null;
    audit[key] = { answer: answers[key] ?? null, by: cwCounts ? "AI" : "NONE", confidence: null, ...evidence };
  }
  return { answers, audit };
}

/** Lawyer overrides win over both classifiers, so they are read back from the stored column. */
export function parseOverrides(raw: unknown): FactorOverrides | null {
  if (!raw || typeof raw !== "object") return null;
  const out: FactorOverrides = {};
  for (const key of FACTOR_KEYS) {
    const v = (raw as Record<string, unknown>)[key];
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    out[key] = {
      answer: typeof o.answer === "string" ? o.answer : null,
      note: typeof o.note === "string" ? o.note : "",
      by: typeof o.by === "string" ? o.by : "",
      at: typeof o.at === "string" ? o.at : "",
    };
  }
  return Object.keys(out).length ? out : null;
}
