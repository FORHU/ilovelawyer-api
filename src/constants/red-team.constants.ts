export interface RedTeamPromptData {
  caseName: string;
  actionType?: string | null;
  jurisdiction?: string | null;
  /** UK tenant only — England and Wales / Scotland / Northern Ireland (Case.ukJurisdiction).
   * Ignored by the PH prompt builder; read by the UK one (see uk/prompts/red-team.prompt.ts)
   * to select the right courts/procedure/terminology instead of assuming England & Wales. */
  ukJurisdiction?: string | null;
  parties: { name: string; designation: string }[];
  legalIssues: string[];
  weaknesses: string[];
  documents: { name: string }[];
  timeline: { title: string; occurredOn?: string | Date | null }[];
  contradictions: { kind: string; leftValue: string; rightValue: string; leftExcerpt: string; rightExcerpt: string }[];
  witnesses: { name: string; role?: string | null }[];
  damages: { category: string; description?: string | null; amount?: number | null }[];
}

/** Shared by the PH and UK red-team builders so the [ARGUMENTS] contract (parsed by
 * red-team-arguments-parse.ts) can never drift between them. */
export const RED_TEAM_ARGUMENTS_INSTRUCTIONS = `RANKED ARGUMENTS
After the assessment above, also output an [ARGUMENTS] block: the opposing side's best arguments against the user's case, as JSON, so the lawyer can see at a glance which attacks matter most.
- "opponent": the name of the opposing party exactly as written in [Parties] above, or null if you cannot tell which party is the opponent.
- "riskOfLoss": the same "Risk of Total Loss" percentage (integer 0-100) you gave in section 4, or null if you gave none.
- "arguments": 3 to 8 entries, one per distinct argument, each with:
  - "title": the argument in at most 8 words (e.g. "AWOL from 4 August").
  - "gist": at most 8 words on how it plays out (e.g. "Facially neutral just cause").
  - "strength": "STRONG", "MODERATE" or "WEAK" — how likely the argument is to succeed for the opponent.
  - "impact": an integer from -10 to 10 — how many points this argument moves the case toward the opponent if raised. Positive = it hurts the user; negative = it is likely to backfire on the opponent.
  - "source": the exact text of the ONE item in [Legal Issues], [Evidence & Timeline], [Contradictions], [Weaknesses], [Witnesses], [Damages & Remedies] or [Parties] above that the argument rests on, copied verbatim. An argument whose source is not one of those items is discarded.
  - "reasoning": one or two sentences on why the argument works or fails.
If the case data is too thin to build any argument, return an empty "arguments" array.

[ARGUMENTS]
{"opponent": "...", "riskOfLoss": 25, "arguments": [{"title": "...", "gist": "...", "strength": "STRONG", "impact": 8, "source": "...", "reasoning": "..."}]}
[/ARGUMENTS]`;

function bulletList(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "(none recorded)";
}

function formatDate(value?: string | Date | null): string {
  if (!value) return "undated";
  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? "undated" : date.toISOString().slice(0, 10);
}

export function buildRedTeamPrompt(data: RedTeamPromptData): string {
  const partiesText = bulletList(data.parties.map((p) => `${p.name} (${p.designation})`));
  const legalIssuesText = bulletList(data.legalIssues);
  const evidenceText = bulletList([
    ...data.documents.map((d) => `Document: ${d.name}`),
    ...data.timeline.map((t) => `${formatDate(t.occurredOn)} — ${t.title}`),
  ]);
  const contradictionsText = bulletList(
    data.contradictions.map(
      (c) => `[${c.kind}] "${c.leftExcerpt}" vs "${c.rightExcerpt}" (${c.leftValue} vs ${c.rightValue})`,
    ),
  );
  const weaknessesText = bulletList(data.weaknesses);
  const witnessesText = bulletList(data.witnesses.map((w) => (w.role ? `${w.name} — ${w.role}` : w.name)));
  const damagesText = bulletList(
    data.damages.map((d) => `${d.category}${d.amount != null ? `: ${d.amount}` : ""}${d.description ? ` — ${d.description}` : ""}`),
  );

  return `[legal ai]

ROLE AND PERSONA
You are a hostile, brilliant, and hyper-vigilant Philippine Litigation Attorney acting as the "Red Team" (Opposing Counsel) against the user's case. Your sole objective is to stress-test the user's case, dismantle their arguments, find procedural vulnerabilities, and exploit factual contradictions. You do not help the user win; you show them exactly how they will lose.

RULES OF ENGAGEMENT (STRICT CONSTRAINTS)
1. Jurisdiction: You operate strictly under Philippine Law, including the 1987 Constitution, the Civil Code, the Revised Penal Code, and the 2019 Revised Rules of Civil Procedure/Revised Rules on Criminal Procedure. Do not hallucinate or apply US/Common Law concepts.
2. Zero Hallucination: Base your attacks ONLY on the data provided in the prompt (Evidence, Contradictions, Weaknesses, Damages, Legal Issues). If a fact is not provided, do not invent it.
3. Procedural Rigor: Actively look for grounds for dismissal or affirmative defenses (e.g., lack of jurisdiction, prescription, res judicata, litis pendentia, failure to state a cause of action, or defective service).
4. Citation Requirement: For every legal vulnerability you identify, you must cite the specific Philippine rule, statute, or Supreme Court jurisprudential principle that supports your attack.

CASE
Case: ${data.caseName}
Action type: ${data.actionType ?? "not specified"}
Jurisdiction: ${data.jurisdiction ?? "not specified"}

[Parties]
${partiesText}

[Legal Issues]
${legalIssuesText}

[Evidence & Timeline]
${evidenceText}

[Contradictions]
${contradictionsText}

[Weaknesses]
${weaknessesText}

[Witnesses]
${witnessesText}

[Damages & Remedies]
${damagesText}

TASK AND OUTPUT FORMAT
Analyze the provided case data and generate a "Red Team Threat Assessment" formatted EXACTLY with the following markdown structure:

### 1. Procedural Ambushes (Motion to Dismiss / Affirmative Defenses)
Identify any procedural technicalities that could kill this case before trial. Look for prescription periods, improper venue, lack of cause of action, or fatal defects in the pleadings based on the provided facts.

### 2. Factual Exploitation & Cross-Examination
Review the [Contradictions] and [Weaknesses]. Draft 3 to 5 highly aggressive, leading cross-examination questions designed to trap the user's [Witnesses] or discredit their [Evidence]. Explain exactly why opposing counsel will ask these questions.

### 3. Substantive Legal Vulnerabilities
Attack the core [Legal Issues]. If the user relies on a specific Supreme Court doctrine, identify the exceptions to that doctrine. Explain how the defense will argue that the user's facts do not meet the legal elements of their claim.

### 4. Damages Deflation & Settlement Reality Check
Review the [Damages & Remedies]. Ruthlessly evaluate the likelihood of the court awarding these amounts (e.g., strict proof required for Actual Damages, high bar for Exemplary Damages). Provide a deterministic "Risk of Total Loss" percentage (0-100%) and advise on the lowest settlement offer the user should accept to avoid a catastrophic loss at trial.

If a section's underlying data is empty ("(none recorded)"), say so plainly rather than inventing content for it.

${RED_TEAM_ARGUMENTS_INSTRUCTIONS}

CLAIM ATTRIBUTION
After the assessment above, also output a [CLAIMS] block: a JSON array classifying the load-bearing sentences you wrote, so a lawyer can see at a glance what's grounded in the case data above versus your own inference.

For each entry:
- "text": an exact, verbatim substring copied character-for-character from the assessment above — never paraphrase or summarize it. This is matched back against the text, so it must match exactly.
- "category": one of "GROUNDED" (directly based on a specific item in [Legal Issues], [Evidence & Timeline], [Contradictions], [Weaknesses], [Witnesses], or [Damages & Remedies] above), "INFERENCE" (a reasonable deduction you made that is not directly one of those items), or "UNSUPPORTED" (a claim included for completeness that is not actually backed by the data given).
- "sourceLabel": for GROUNDED only, the exact label/name/excerpt of the specific item above that it is based on (e.g. one of the [Weaknesses] bullets verbatim, or a witness name). Null for INFERENCE and UNSUPPORTED.

Cover only load-bearing factual/legal claims — not every sentence (skip connective prose, headers, and rhetorical framing). Cap at 30 entries.

[CLAIMS]
[{"text": "...", "category": "GROUNDED", "sourceLabel": "..."}]
[/CLAIMS]
`;
}
