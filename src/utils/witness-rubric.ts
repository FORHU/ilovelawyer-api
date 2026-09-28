export type WitnessStatusValue = "READY" | "ADVERSE" | "OUTSTANDING";

/**
 * Deterministic witness-credibility scorer. Measures how reliable an account looks on the papers
 * (not truthfulness or demeanour). A classifier only supplies one option per factor; the score,
 * band, flags and suggested status are all computed here so the same answers always give the same
 * result. Weights and band cut-offs are provisional until counsel signs them off.
 */
export const RUBRIC_VERSION = 1;

export const RUBRIC = {
  A: { label: "Basis of knowledge", options: { OWN: 20, MIXED: 10, REPORTED: 0 } },
  B: { label: "Specificity", options: { SPECIFIC: 10, SOME: 5, VAGUE: 0 } },
  C: { label: "Contemporaneity", options: { WEEKS: 10, MONTHS: 5, OVER_YEAR: 0 } },
  D: { label: "Internal consistency", options: { NONE: 15, MINOR: 8, MATERIAL: 0 } },
  E: { label: "Corroboration", options: { CONFIRMED: 20, PARTIAL: 10, UNSUPPORTED: 0 } },
  F: { label: "Contradiction", options: { NONE: 15, PERIPHERAL: 8, CENTRAL: 0 } },
  G: { label: "Interest or motive", options: { NONE: 10, SOME: 5, DIRECT_STAKE: 0 } },
} as const;

export type FactorKey = keyof typeof RUBRIC;
export const FACTOR_KEYS = Object.keys(RUBRIC) as FactorKey[];

/** One option per factor; null/absent = the papers don't show it (not assessable, never zero). */
export type FactorAnswers = Partial<Record<FactorKey, string | null>>;

/** Without these two the score would rest on too little to mean anything. */
const REQUIRED_FACTORS: FactorKey[] = ["A", "D"];
const MIN_ASSESSABLE_POINTS = 60;

export type CredibilityBand = "HIGH" | "MODERATE" | "LOW" | "WEAK";
const BANDS: { min: number; band: CredibilityBand }[] = [
  { min: 75, band: "HIGH" },
  { min: 55, band: "MODERATE" },
  { min: 35, band: "LOW" },
  { min: 0, band: "WEAK" },
];

export type WitnessFlag = "CENTRAL_CONTRADICTION" | "MAINLY_HEARSAY" | "STATEMENT_NOT_RECEIVED" | "DIRECT_STAKE";

export interface FactorPoints {
  answer: string | null;
  /** Null when not assessable. */
  points: number | null;
  max: number;
}

export interface RubricResult {
  version: number;
  factors: Record<FactorKey, FactorPoints>;
  earned: number;
  assessable: number;
  /** Null = "Insufficient information" — see `insufficientReason`. */
  score: number | null;
  band: CredibilityBand | null;
  insufficientReason: string | null;
  flags: WitnessFlag[];
  suggestedStatus: WitnessStatusValue;
}

function maxPoints(key: FactorKey): number {
  return Math.max(...Object.values(RUBRIC[key].options));
}

/** An answer that isn't one of the factor's options is treated as not assessable. */
function pointsFor(key: FactorKey, answer: string | null | undefined): number | null {
  if (!answer) return null;
  const options = RUBRIC[key].options as Record<string, number>;
  return Object.prototype.hasOwnProperty.call(options, answer) ? options[answer] : null;
}

export function bandFor(score: number): CredibilityBand {
  return BANDS.find((b) => score >= b.min)!.band;
}

export function scoreWitness(answers: FactorAnswers, statementReceived: boolean): RubricResult {
  const factors = {} as Record<FactorKey, FactorPoints>;
  let earned = 0;
  let assessable = 0;
  for (const key of FACTOR_KEYS) {
    const points = pointsFor(key, answers[key]);
    factors[key] = { answer: points === null ? null : (answers[key] as string), points, max: maxPoints(key) };
    if (points !== null) {
      earned += points;
      assessable += factors[key].max;
    }
  }

  const missing = REQUIRED_FACTORS.filter((k) => factors[k].points === null);
  let insufficientReason: string | null = null;
  if (missing.length) {
    insufficientReason = `${missing.map((k) => RUBRIC[k].label).join(" and ")} could not be assessed from the papers.`;
  } else if (assessable < MIN_ASSESSABLE_POINTS) {
    insufficientReason = `Only ${assessable} of 100 points could be assessed (minimum ${MIN_ASSESSABLE_POINTS}).`;
  }

  const score = insufficientReason ? null : Math.round((earned / assessable) * 100);
  const band = score === null ? null : bandFor(score);

  const flags: WitnessFlag[] = [];
  if (answers.F === "CENTRAL") flags.push("CENTRAL_CONTRADICTION");
  if (answers.A === "REPORTED") flags.push("MAINLY_HEARSAY");
  if (!statementReceived) flags.push("STATEMENT_NOT_RECEIVED");
  if (answers.G === "DIRECT_STAKE") flags.push("DIRECT_STAKE");

  let suggestedStatus: WitnessStatusValue;
  // OUTSTANDING means something is missing (statement or information); a scored witness is
  // READY when credible and otherwise ADVERSE, so a Low band is not left in limbo.
  if (flags.includes("CENTRAL_CONTRADICTION") || band === "WEAK" || band === "LOW") suggestedStatus = "ADVERSE";
  else if (!statementReceived || score === null) suggestedStatus = "OUTSTANDING";
  else suggestedStatus = "READY";

  return { version: RUBRIC_VERSION, factors, earned, assessable, score, band, insufficientReason, flags, suggestedStatus };
}

/**
 * The wording each classifier is given, one place so the Chat Wonder prompt and the Jev questions
 * can't drift apart. Options are defined by what the papers show, never by an impression.
 */
export const FACTOR_DEFINITIONS: Record<FactorKey, { question: string; options: Record<string, string> }> = {
  A: {
    question: "On what basis does the witness know what they say?",
    options: {
      OWN: "they describe what they personally saw, did or heard, or cite their own records",
      MIXED: "part is first-hand and part is repeated from others or unsourced",
      REPORTED: "most of it is repeated from others, or the source of their knowledge is not stated",
    },
  },
  B: {
    question: "How specific is the account?",
    options: {
      SPECIFIC: "it gives named dates, places, people or amounts for the key events",
      SOME: "some key events are specific and others are general",
      VAGUE: "the key events are described only in general terms",
    },
  },
  C: {
    question: "How soon after the events was the account made?",
    options: {
      WEEKS: "within a few weeks of the events, or it is a contemporaneous record",
      MONTHS: "within a year but more than a few weeks after",
      OVER_YEAR: "more than a year after the events",
    },
  },
  D: {
    question: "Is the account consistent within itself?",
    options: {
      NONE: "no part of the account conflicts with another part",
      MINOR: "small inconsistencies on points that do not affect the substance",
      MATERIAL: "parts of the account conflict on a point that matters to the case",
    },
  },
  E: {
    question: "Do other documents in the case bear out the account?",
    options: {
      CONFIRMED: "independent documents or other witnesses confirm the key points",
      PARTIAL: "some key points are confirmed and others are not addressed",
      UNSUPPORTED: "other documents that could confirm the account exist and do not support it",
    },
  },
  F: {
    question: "Does anything in the case contradict the account?",
    options: {
      NONE: "no listed contradiction or other document conflicts with it",
      PERIPHERAL: "a conflict exists but on a side point",
      CENTRAL: "a conflict exists on a point the case depends on",
    },
  },
  G: {
    question: "Does the witness have an interest in the outcome?",
    options: {
      NONE: "nothing in the papers suggests any stake or motive",
      SOME: "a relationship, employment or loyalty that could colour the account",
      DIRECT_STAKE: "the witness stands to gain or lose directly from the outcome",
    },
  },
};
