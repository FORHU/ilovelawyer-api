import { FACTOR_DEFINITIONS, FACTOR_KEYS, RUBRIC } from "../utils/witness-rubric";

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

function renderFactorQuestions(): string {
  return FACTOR_KEYS.map((k) => {
    const def = FACTOR_DEFINITIONS[k];
    const options = Object.keys(RUBRIC[k].options)
      .map((o) => `    ${o} — ${def.options[o]}`)
      .join("\n");
    return `${k}. ${RUBRIC[k].label}: ${def.question}\n${options}`;
  }).join("\n");
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
Do not score the witnesses. For each witness, answer the fixed questions below from what their sponsored document text actually says and from the contradictions, other witnesses' texts and timeline listed. The application computes the score itself.
${renderFactorQuestions()}
Rules for every answer:
- Pick exactly one option per factor, using the option names shown. If the data above does not let you tell, answer null. Never guess and never pick a middle option as filler.
- Every non-null answer needs a "quote": a passage copied word for word from the text above that your answer relies on, and the "document" it comes from. For C, quote the passage that dates the account or events. For F, quote the listed contradiction. If you cannot quote it, answer null.
- For every one of the seven factors, whether or not you answered it, add one entry to "needs": a short, concrete next step that would settle or firm up that factor, such as who to ask for which record, or what to get the witness to confirm. It may be something outside this system. Do not invent facts or name people or documents that are not in the data above.
- Give 2-4 short "reasons" per witness, each naming the evidence item, contradiction or timeline entry it relies on in "source", or null.

Respond with a short plain-text summary, then the machine-readable block below, exactly in this format:
[SCORES]
[{"witnessId":"<id from above>","factors":{"A":{"answer":"OWN","quote":"...","document":"..."},"B":{"answer":null,"quote":null,"document":null},"C":{},"D":{},"E":{},"F":{},"G":{}},"reasons":[{"text":"...","source":"..."}],"needs":[{"factor":"E","text":"..."}]}]
[/SCORES]`;
}

export function buildWitnessScoringPrompt(data: WitnessScoringPromptData): string {
  return `You are assessing witness credibility for a litigation team in the Philippines. Case: ${data.caseName}${
    data.actionType ? ` (${data.actionType})` : ""
  }${data.jurisdiction ? `, venue: ${data.jurisdiction}` : ""}.

${renderWitnessScoringBody(data)}`;
}
