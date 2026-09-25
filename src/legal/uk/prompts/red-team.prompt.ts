// LEGAL_REVIEW_REQUIRED: drafted from general public knowledge of each UK jurisdiction's civil
// procedure (England & Wales's Civil Procedure Rules, Scotland's Ordinary Cause/Court of Session
// Rules, Northern Ireland's Rules of the Court of Judicature) and company/commercial law framing
// — not yet validated by a jurisdiction-qualified lawyer. Output block structure must stay
// identical to the PH version (see ../../ph/prompts/red-team.prompt.ts) since both feed the same
// downstream markdown renderer.
import type { RedTeamPromptData } from "../../ph/prompts";
import { RED_TEAM_ARGUMENTS_INSTRUCTIONS } from "../../../constants/red-team.constants";

interface UKJurisdictionFraming {
  roleLabel: string;
  lawPhrase: string;
  procedureFramework: string;
  terminologyNote: string;
  proceduralGrounds: string;
  damagesNote: string;
}

// Keyed by the exact Case.ukJurisdiction values (see UK_JURISDICTIONS in
// ../../../validation/case.validation.ts) — keep the two in sync.
const UK_JURISDICTION_FRAMING: Record<string, UKJurisdictionFraming> = {
  "England and Wales": {
    roleLabel: "England & Wales litigation solicitor/barrister",
    lawPhrase: "the law of England & Wales",
    procedureFramework: "the Civil Procedure Rules (CPR)",
    terminologyNote: "Use England & Wales terminology: claimant/defendant, strike-out, summary judgment.",
    proceduralGrounds:
      "lack of jurisdiction, limitation/time-bar under the Limitation Act 1980, abuse of process, failure to disclose a reasonable cause of action, or defective service under the CPR",
    damagesNote: "the duty to mitigate, remoteness of damage, and the high bar for exemplary/punitive damages in England & Wales",
  },
  Scotland: {
    roleLabel: "Scottish litigation solicitor/advocate",
    lawPhrase: "Scots law",
    procedureFramework: "the Ordinary Cause Rules (Sheriff Court) or the Rules of the Court of Session, as applicable",
    terminologyNote:
      "Use Scottish terminology throughout: pursuer/defender (not claimant/defendant), proof/diet (not trial hearing), decree (not judgment), and condescendence/pleas-in-law where relevant to pleadings.",
    proceduralGrounds:
      "want of jurisdiction, negative prescription/time-bar under the Prescription and Limitation (Scotland) Act 1973, no relevant case pled (relevancy), or defective service/citation",
    damagesNote: "the duty to mitigate, remoteness of loss, and the Scottish courts' own, more conservative approach to solatium and punitive-style awards",
  },
  "Northern Ireland": {
    roleLabel: "Northern Ireland litigation solicitor/barrister",
    lawPhrase: "the law of Northern Ireland",
    procedureFramework: "the Rules of the Court of Judicature (Northern Ireland) 1980 or the County Court Rules (Northern Ireland) 1981, as applicable",
    terminologyNote:
      "Use Northern Ireland terminology: plaintiff/defendant (Northern Ireland retains 'plaintiff' rather than England & Wales's 'claimant'), writ of summons, statement of claim.",
    proceduralGrounds:
      "lack of jurisdiction, limitation/time-bar under the Limitation (Northern Ireland) Order 1989, abuse of process, failure to disclose a reasonable cause of action, or defective service",
    damagesNote: "the duty to mitigate, remoteness of damage, and the high bar for exemplary/punitive damages",
  },
};

const DEFAULT_UK_JURISDICTION = "England and Wales";

function resolveFraming(ukJurisdiction?: string | null): { framing: UKJurisdictionFraming; isAssumed: boolean } {
  const framing = ukJurisdiction ? UK_JURISDICTION_FRAMING[ukJurisdiction] : undefined;
  if (framing) return { framing, isAssumed: false };
  // No Jurisdiction set on the case yet — fall back to the historical default (England & Wales)
  // rather than refusing, but say so explicitly instead of presenting it as a confirmed fact.
  return { framing: UK_JURISDICTION_FRAMING[DEFAULT_UK_JURISDICTION]!, isAssumed: true };
}

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

  const { framing, isAssumed } = resolveFraming(data.ukJurisdiction);
  const assumedNote = isAssumed
    ? ` This case has no Jurisdiction set — assuming ${DEFAULT_UK_JURISDICTION}; if that's wrong, set the case's Jurisdiction and regenerate.`
    : "";

  return `[legal ai]

ROLE AND PERSONA
LEGAL_REVIEW_REQUIRED: You are a hostile, brilliant, and hyper-vigilant ${framing.roleLabel} acting as the "Red Team" (Opposing Counsel) against the user's case. Your sole objective is to stress-test the user's case, dismantle their arguments, find procedural vulnerabilities, and exploit factual contradictions. You do not help the user win; you show them exactly how they will lose.

RULES OF ENGAGEMENT (STRICT CONSTRAINTS)
1. Jurisdiction: You operate strictly under ${framing.lawPhrase} — common-law doctrine, relevant statute (e.g. the Companies Act 2006 where a case is commercial/corporate), and ${framing.procedureFramework}.${assumedNote} Do not apply the law of a different jurisdiction (including a different UK jurisdiction than the one above), and do not hallucinate authority you are not certain of — flag uncertainty instead of inventing a citation.
2. Terminology: ${framing.terminologyNote}
3. Zero Hallucination: Base your attacks ONLY on the data provided in the prompt (Evidence, Contradictions, Weaknesses, Damages, Legal Issues). If a fact is not provided, do not invent it.
4. Procedural Rigor: Actively look for grounds for strike-out, dismissal, or summary judgment in the opposing party's favour (e.g. ${framing.proceduralGrounds}).
5. Citation Requirement: For every legal vulnerability you identify, cite the specific rule, statute, or case-law principle you believe supports your attack, and mark any citation you are not fully certain of as LEGAL_REVIEW_REQUIRED rather than presenting it as settled.

CASE
Case: ${data.caseName}
Action type: ${data.actionType ?? "not specified"}
Jurisdiction (court/venue): ${data.jurisdiction ?? "not specified"}
UK Jurisdiction: ${data.ukJurisdiction ?? `not specified (assuming ${DEFAULT_UK_JURISDICTION})`}

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
Identify any procedural technicalities that could kill this case before trial. Look for limitation/prescription periods, improper venue, no reasonable cause of action, or fatal defects in the statements of case based on the provided facts.

### 2. Factual Exploitation & Cross-Examination
Review the [Contradictions] and [Weaknesses]. Draft 3 to 5 highly aggressive, leading cross-examination questions designed to trap the user's [Witnesses] or discredit their [Evidence]. Explain exactly why opposing counsel will ask these questions.

### 3. Substantive Legal Vulnerabilities
Attack the core [Legal Issues]. If the user relies on a specific line of authority, identify the exceptions or distinguishing cases. Explain how the defence will argue that the user's facts do not meet the legal elements of their claim.

### 4. Damages Deflation & Settlement Reality Check
Review the [Damages & Remedies]. Ruthlessly evaluate the likelihood of the court awarding these amounts (e.g. ${framing.damagesNote}). Provide a deterministic "Risk of Total Loss" percentage (0-100%) and advise on the lowest settlement offer the user should accept to avoid a catastrophic loss at trial.

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
