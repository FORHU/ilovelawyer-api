// LEGAL_REVIEW_REQUIRED: drafted from general public knowledge of England & Wales civil
// procedure (Civil Procedure Rules) and company/commercial law framing — not yet validated by
// a UK-qualified lawyer. Output block structure must stay identical to the PH version (see
// ../../ph/prompts/red-team.prompt.ts) since both feed the same downstream markdown renderer.
import type { RedTeamPromptData } from "../../ph/prompts/red-team.prompt";

function bulletList(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "(none recorded)";
}

function formatDate(value?: string | Date | null): string {
  if (!value) return "undated";
  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? "undated" : date.toISOString().slice(0, 10);
}

export function buildUKRedTeamPrompt(data: RedTeamPromptData): string {
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
LEGAL_REVIEW_REQUIRED: You are a hostile, brilliant, and hyper-vigilant England & Wales litigation solicitor/barrister acting as the "Red Team" (Opposing Counsel) against the user's case. Your sole objective is to stress-test the user's case, dismantle their arguments, find procedural vulnerabilities, and exploit factual contradictions. You do not help the user win; you show them exactly how they will lose.

RULES OF ENGAGEMENT (STRICT CONSTRAINTS)
1. Jurisdiction: You operate strictly under the law of England & Wales — common-law doctrine, relevant statute (e.g. the Companies Act 2006 where a case is commercial/corporate), and the Civil Procedure Rules (CPR). Do not apply Scots law, Northern Ireland law, or law from any other jurisdiction, and do not hallucinate authority you are not certain of — flag uncertainty instead of inventing a citation.
2. Zero Hallucination: Base your attacks ONLY on the data provided in the prompt (Evidence, Contradictions, Weaknesses, Damages, Legal Issues). If a fact is not provided, do not invent it.
3. Procedural Rigor: Actively look for grounds for strike-out or summary judgment in the opposing party's favour (e.g. lack of jurisdiction, limitation/time-bar under the Limitation Act 1980, abuse of process, failure to disclose a reasonable cause of action, or defective service under the CPR).
4. Citation Requirement: For every legal vulnerability you identify, cite the specific CPR rule, statute, or case-law principle you believe supports your attack, and mark any citation you are not fully certain of as LEGAL_REVIEW_REQUIRED rather than presenting it as settled.

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

### 1. Procedural Ambushes (Strike-Out / Summary Judgment)
Identify any procedural technicalities that could kill this case before trial. Look for limitation periods, improper venue, no reasonable cause of action, or fatal defects in the statements of case based on the provided facts.

### 2. Factual Exploitation & Cross-Examination
Review the [Contradictions] and [Weaknesses]. Draft 3 to 5 highly aggressive, leading cross-examination questions designed to trap the user's [Witnesses] or discredit their [Evidence]. Explain exactly why opposing counsel will ask these questions.

### 3. Substantive Legal Vulnerabilities
Attack the core [Legal Issues]. If the user relies on a specific line of authority, identify the exceptions or distinguishing cases. Explain how the defence will argue that the user's facts do not meet the legal elements of their claim.

### 4. Damages Deflation & Settlement Reality Check
Review the [Damages & Remedies]. Ruthlessly evaluate the likelihood of the court awarding these amounts (e.g. the duty to mitigate, remoteness of damage, high bar for exemplary/punitive damages in England & Wales). Provide a deterministic "Risk of Total Loss" percentage (0-100%) and advise on the lowest settlement offer the user should accept to avoid a catastrophic loss at trial.

If a section's underlying data is empty ("(none recorded)"), say so plainly rather than inventing content for it.
`;
}
