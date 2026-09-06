import LawSvc from "../services/law.service";

export interface CitationResolutionInput {
  caseNumber?: string | null;
  title?: string | null;
  year?: number | null;
}

export interface CitationResolutionResult {
  lawId: string;
  confidence: number;
}

// Minimal shape this module needs from a LawSvc.search result item — kept separate from the
// full JurisPhItem so pickBestMatch stays pure/unit-testable with plain literal objects.
export interface CitationCandidate {
  stored_id: string;
  case_number?: string;
  year?: number | null;
}

const EXACT_CASE_NUMBER_CONFIDENCE = 0.95;
const YEAR_MATCH_CONFIDENCE = 0.6;
const FALLBACK_CONFIDENCE = 0.35;
// Below this, treat as unresolved rather than linking to a possibly-wrong case.
const MIN_CONFIDENCE = 0.3;

function normalizeCaseNumber(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Pure matcher: given already-fetched search candidates, pick the best one for this citation —
 * or null if nothing clears the confidence bar. LawRepo.localSearch (behind LawSvc.search) is a
 * plain ILIKE with no disambiguation, so this never claims certainty; callers should treat a
 * null result as "not found," not "found but unsure," and render it as an unresolved node
 * rather than linking to a possibly-wrong case. Separated from resolveCitationToLaw below so
 * this logic is testable without a DB or network call.
 */
export function pickBestMatch(
  candidates: CitationCandidate[],
  input: CitationResolutionInput,
): CitationResolutionResult | null {
  if (candidates.length === 0) return null;

  // An exact case-number match beats whatever order the (relevance-unaware) local search returned.
  if (input.caseNumber) {
    const exact = candidates.find(
      (item) => item.case_number && normalizeCaseNumber(item.case_number) === normalizeCaseNumber(input.caseNumber!),
    );
    if (exact?.stored_id) return { lawId: exact.stored_id, confidence: EXACT_CASE_NUMBER_CONFIDENCE };
  }

  const best = candidates[0];
  if (!best?.stored_id) return null;

  const confidence = input.year && best.year === input.year ? YEAR_MATCH_CONFIDENCE : FALLBACK_CONFIDENCE;
  if (confidence < MIN_CONFIDENCE) return null;

  return { lawId: best.stored_id, confidence };
}

/**
 * Best-effort match of an LLM-extracted (or user-typed) citation against the Law corpus, via
 * the existing local-first-then-juris.ph search (LawSvc.search).
 */
export async function resolveCitationToLaw(input: CitationResolutionInput): Promise<CitationResolutionResult | null> {
  const query = input.caseNumber?.trim() || input.title?.trim();
  if (!query) return null;

  let result: Awaited<ReturnType<typeof LawSvc.search>>;
  try {
    result = await LawSvc.search({ category: "JURISPRUDENCE", q: query, limit: 3 });
  } catch {
    // juris.ph unreachable and nothing stored locally — unresolved, not fatal.
    return null;
  }

  return pickBestMatch(result.items, input);
}
