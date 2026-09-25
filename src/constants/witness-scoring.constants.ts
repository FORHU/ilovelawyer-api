export interface WitnessScoringPromptData {
  caseName: string;
  actionType?: string | null;
  jurisdiction?: string | null;
  /** UK tenant only — see RedTeamPromptData.ukJurisdiction. */
  ukJurisdiction?: string | null;
  witnesses: {
    id: string;
    name: string;
    role?: string | null;
    summary?: string | null;
    statementReceived: boolean;
    /** Documents this witness sponsors, with the contradictions each is part of. */
    sponsoredEvidence: { name: string; hearsay: string; contradictions: string[]; excerpt?: string }[];
  }[];
  timeline: { title: string; occurredOn?: string | Date | null }[];
}

function formatDate(value?: string | Date | null): string {
  if (!value) return "undated";
  const date = typeof value === "string" ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? "undated" : date.toISOString().slice(0, 10);
}

function renderWitnessBlock(w: WitnessScoringPromptData["witnesses"][number]): string {
  const evidence =
    w.sponsoredEvidence.length === 0
      ? "  (no sponsored evidence recorded)"
      : w.sponsoredEvidence
          .map((e) => {
            const c = e.contradictions.length ? ` | contradicted: ${e.contradictions.join(" ; ")}` : "";
            const text = e.excerpt ? `\n    text: """${e.excerpt}"""` : "\n    text: (not available)";
            return `  - ${e.name} [hearsay: ${e.hearsay}]${c}${text}`;
          })
          .join("\n");
  return [
    `id: ${w.id}`,
    `name: ${w.name}`,
    `role: ${w.role || "unspecified"}`,
    `can speak to: ${w.summary || "unspecified"}`,
    `written statement received: ${w.statementReceived ? "yes" : "no"}`,
    `sponsored evidence:\n${evidence}`,
  ].join("\n");
}

/** Everything after the tenant-specific opening line — shared by the PH and UK builders so the
 * output contract ([SCORES] block) can never drift between them. */
export function renderWitnessScoringBody(data: WitnessScoringPromptData): string {
  const witnessesText = data.witnesses.map(renderWitnessBlock).join("\n\n");
  const timelineText = data.timeline.length
    ? data.timeline.map((t) => `- ${formatDate(t.occurredOn)} — ${t.title}`).join("\n")
    : "(none recorded)";
  return `WITNESSES:
${witnessesText}

TIMELINE:
${timelineText}

INSTRUCTIONS:
Use ONLY the data above. Do not use outside knowledge and do not invent facts.
For each witness, assess how credible their account is likely to be, considering: whether they have first-hand knowledge (role and what they can speak to), whether their sponsored evidence is corroborated or contradicted, hearsay exposure, and whether a written statement has been received.
Base the score on what the sponsored document text actually says: internal consistency, specificity (dates, places, amounts, sources of knowledge), first-hand versus second-hand knowledge, and agreement or conflict with the other witnesses' texts and with the contradictions listed.
If the text of a witness's sponsored evidence is not available, or there is too little information to judge, set "credibility" to null and give one reason saying what is missing. Never use 50 as a filler for "unknown" — use null. Use a score near 50 only when the evidence is genuinely balanced.
"credibility" is an integer 0-100 (0 = not credible, 50 = neutral, 100 = highly credible).
"suggestedStatus" is one of READY (credible, statement in hand), ADVERSE (contradicted or likely to hurt our case) or OUTSTANDING (statement or key information still missing). It is only a suggestion for the lawyer.
Give 2-4 short reasons per witness. Each reason's "source" must name the evidence item, contradiction or timeline entry it relies on, or be null.

Respond with a short plain-text summary, then the machine-readable block below, exactly in this format:
[SCORES]
[{"witnessId":"<id from above>","credibility":72,"suggestedStatus":"READY","reasons":[{"text":"...","source":"..."}]}]
[/SCORES]`;
}

export function buildWitnessScoringPrompt(data: WitnessScoringPromptData): string {
  return `You are assessing witness credibility for a litigation team in the Philippines. Case: ${data.caseName}${
    data.actionType ? ` (${data.actionType})` : ""
  }${data.jurisdiction ? `, venue: ${data.jurisdiction}` : ""}.

${renderWitnessScoringBody(data)}`;
}
