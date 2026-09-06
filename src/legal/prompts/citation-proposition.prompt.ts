/** Tenant-neutral — this is a plain text-comparison task, not a jurisdiction-specific legal
 * question, so there's no PH/UK split the way the case-content prompts have. tenantCode is
 * still passed through to Chat Wonder by the caller for persona routing (see chatWonder.ts's
 * withLegalTag), just not reflected in this prompt's wording. */
export function buildCitationPropositionPrompt(quotedText: string, officialText: string): string {
  return `[legal ai]

## TASK
A lawyer wrote the QUOTED TEXT below, citing it against the OFFICIAL TEXT below. The quoted text
already does not appear verbatim in the official text (that check already ran separately) — your
job is only to classify HOW it relates to the official text.

## QUOTED TEXT
${quotedText}

## OFFICIAL TEXT
${officialText.slice(0, 8000)}

## CLASSIFICATION
Choose exactly one:
- PARAPHRASED: the official text states the same specific fact or holding, just in different
  words — a fair restatement, not a new claim.
- INFERRED: the quoted text draws a conclusion that is not directly stated in the official text,
  even if it's a reasonable reading of it.
- UNSUPPORTED: the official text does not actually support the quoted text at all.

Base this only on the two texts above. Do not use outside knowledge of the source.

## OUTPUT
Reply with exactly this block and nothing else — no preamble, no closing remarks.

[PROPOSITION]
{"type": "PARAPHRASED", "reasoning": "one sentence explaining why"}
[/PROPOSITION]
`;
}
