// Shared by the PH and UK case-outlook prompts: the case material section and the output contract
// are identical across jurisdictions, only the ROLE framing and party labels differ.

export interface CaseOutlookPromptInput {
  docs: { id: string; name: string }[];
  findings: { category: string; label: string }[];
  openRisks: { title: string; severity: string }[];
  contradictions: { factKey: string; leftValue: string; rightValue: string }[];
  deadlines: { label: string; computedDueDate: Date }[];
  /** Case.language — the rationale and driver labels are written in it. */
  language: string;
  ukJurisdiction?: string | null;
}

export function formatCaseOutlookMaterial(input: CaseOutlookPromptInput): string {
  const docs = input.docs.map((doc) => `- \`${doc.id}\` — ${doc.name}`).join("\n");
  const findings = bullets(input.findings.map((f) => `[${f.category}] ${f.label}`));
  const risks = bullets(input.openRisks.map((r) => `[${r.severity}] ${r.title}`));
  const contradictions = bullets(input.contradictions.map((c) => `${c.factKey}: "${c.leftValue}" vs "${c.rightValue}"`));
  const deadlines = bullets(input.deadlines.map((d) => `${d.label} — due ${d.computedDueDate.toISOString().slice(0, 10)}`));

  return `## DOCUMENTS
${docs}

## FINDINGS
${findings}

## OPEN RISKS
${risks}

## CONTRADICTIONS
${contradictions}

## DEADLINES
${deadlines}`;
}

export function caseOutlookOutputContract(language: string): string {
  return `## OUTPUT
Reply with this one block and nothing else. No markdown, no [Sources], no related cases.

[CASE_OUTLOOK]
{"band": "...", "confidence": "...", "rationale": "...", "drivers": []}
[/CASE_OUTLOOK]

- "band": exactly one of FAVORABLE, LEANS_FAVORABLE, UNCERTAIN, LEANS_UNFAVORABLE, UNFAVORABLE.
- "confidence": exactly one of LOW, MEDIUM, HIGH — how well the material supports the band. Thin, one-sided or contradictory evidence means LOW.
- "rationale": 2-4 sentences explaining the band, written in language "${language}".
- "drivers": up to 6 objects {"label": "...", "direction": "HELPS" | "HURTS", "sourceDocId": "..."}. "label" is one short line in language "${language}". "sourceDocId" is a document id copied exactly from DOCUMENTS; leave it out if the driver isn't tied to one document.

Never give a percentage, probability, score or any other number for the outcome. Never invent document ids.`;
}

function bullets(lines: string[]): string {
  return lines.length ? lines.map((line) => `- ${line}`).join("\n") : "(none)";
}
