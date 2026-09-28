export interface CitationGroundsPromptData {
  /** "the Philippines" / "England and Wales" — framing only; the output contract is shared. */
  jurisdictionLabel: string;
  caseName: string;
  claims: { id: string; title: string; causeOfAction: string | null }[];
  authorities: { id: string; reference: string; title: string | null; quotedText: string }[];
}

const MAX_QUOTED_CHARS = 300;

/** Asks which pleaded claim(s) each of the case's cited authorities attaches to. Ids in the reply
 * are checked against the ones sent (extractCitationGrounds), so the model can't link to anything
 * that isn't on the case. */
export function buildCitationGroundsPrompt(data: CitationGroundsPromptData): string {
  const claims = data.claims
    .map((c) => `- id: ${c.id} | ${c.title}${c.causeOfAction ? ` | pleaded under: ${c.causeOfAction}` : ""}`)
    .join("\n");
  const authorities = data.authorities
    .map(
      (a) =>
        `- id: ${a.id} | ${a.reference}${a.title && a.title !== a.reference ? ` | ${a.title}` : ""}\n  cited for: "${a.quotedText.slice(0, MAX_QUOTED_CHARS)}"`,
    )
    .join("\n");
  return `You are mapping a litigation team's cited authorities to the claims they plead, for a case in ${data.jurisdictionLabel}. Case: ${data.caseName}.

CLAIMS (the pleaded grounds):
${claims}

AUTHORITIES (statutes, rules and cases the team cites, with the passage each is cited for):
${authorities}

INSTRUCTIONS:
For each authority, list the claim or claims it actually bears on. An authority may attach to more than one claim, or to none — leave it out rather than stretch it.
"role" is "SUBSTANTIVE" when the authority states or applies the rule the claim rests on, or "PROCEDURAL" when it sets a procedure whose breach is itself the claim or part of it (for example a notice or hearing requirement).
"reason" is one line (max 160 characters) on how it attaches.
Use only the ids listed above.

Respond with the machine-readable block below and nothing else, exactly in this format:
[GROUNDS]
[{"citationId":"<authority id>","claimId":"<claim id>","role":"SUBSTANTIVE","reason":"..."}]
[/GROUNDS]`;
}
