/** One document as the cross-examination prompt shows it: its handle (D1, D2, …) in place of the id,
 * for the same reason as case-document-handles.ts, and the text the quotes must come from. */
export interface CrossExamPromptDocument {
  handle: string;
  name: string;
  text: string;
}

export interface CrossExamPromptInput {
  caseName: string;
  witness: { name: string; role: string | null; summary: string | null };
  documents: CrossExamPromptDocument[];
  /** "D2 p.3 \"…\" vs D5 p.1 \"…\"" lines for contradictions touching the documents above. */
  contradictions: string[];
  /** The witness's weak credibility factors, one line each, from the rubric. */
  credibilityPoints: string[];
}

/** Caps the parser enforces as well, so the prompt and the parser can't disagree. */
export const CROSS_EXAM_MAX_QUESTIONS = 25;
export const CROSS_EXAM_MAX_QUOTE = 400;

/**
 * Cross-examination questions for a witness the other side calls. One builder for both tenants
 * (prompt-registry maps PH and UK to it): leading, one-fact questions put to an opposing witness
 * are the same technique in both, and nothing here states a rule of law. `caseArticle` carries
 * the only jurisdiction-specific wording, as in buildMissingEvidencePromptBody.
 *
 * Every question must rest on a verbatim passage from one listed document. CrossExaminationSvc
 * drops any question whose passage is not found in that document's text, so a question can never
 * reach the lawyer resting on words nobody wrote.
 */
export function buildCrossExaminationPromptBody(input: CrossExamPromptInput, caseArticle: string): string {
  const { witness } = input;
  const docBlocks = input.documents
    .map((doc) => `[${doc.handle}] ${doc.name}\n<<<\n${doc.text}\n>>>`)
    .join("\n\n");

  return `[legal ai]

## ROLE
You are helping the advocate in ${caseArticle} case prepare to cross-examine a witness called by the other side. You are not advising on the merits, citing authority, or preparing this witness's own evidence.

## WITNESS
Name: ${witness.name}
Role: ${witness.role || "not recorded"}
Summary: ${witness.summary || "not recorded"}

## WHAT TO TEST
Contradictions between documents:
${input.contradictions.length ? input.contradictions.map((c) => `- ${c}`).join("\n") : "- none recorded"}

Weak points in this witness's credibility:
${input.credibilityPoints.length ? input.credibilityPoints.map((c) => `- ${c}`).join("\n") : "- none recorded"}

## TASK
Plan a cross-examination of ${witness.name} in short topics (at most 6). Within each topic, write leading questions in the order they would be put, building to the point the topic establishes.

Each question:
- is leading and closed: it states one fact and invites "yes" or "no",
- puts one fact only — never two facts joined by "and",
- never asks "why" or invites an explanation,
- rests on exactly one passage copied word for word from one document below.

Use only the documents below. Do not invent facts, dates, amounts or names. If the documents give nothing to test this witness on, reply with the empty array.

## DOCUMENTS
${docBlocks}

## OUTPUT
Reply with this one block and nothing else. No markdown, no [Sources], no commentary.

[CROSS_EXAMINATION]
[]
[/CROSS_EXAMINATION]

A JSON array of objects, at most ${CROSS_EXAM_MAX_QUESTIONS}, in the order they would be asked, each carrying:
- "topic": the topic this question belongs to, as a short noun phrase (max 80 characters), the same text for every question in the topic.
- "question": the question as it would be put to the witness (max 300 characters).
- "purpose": what the answer establishes, in one line (max 200 characters).
- "document": the handle of the document the passage comes from (e.g. "D2"), copied exactly.
- "quote": the passage, copied word for word from that document (max ${CROSS_EXAM_MAX_QUOTE} characters). Do not paraphrase, shorten inside, or join two passages.
`;
}
