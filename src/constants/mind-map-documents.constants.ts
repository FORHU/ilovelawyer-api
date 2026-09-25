import { MIND_MAP_LIMITS } from "./mind-map-limits.constants";

export interface MindMapDocumentsPromptData {
  docs: { id: string; name: string }[];
  /** Case findings, e.g. "LEGAL_ISSUE: Validity of the demand letter". */
  findings: { category: string; label: string }[];
  /** Key dates already pulled into the case timeline. */
  keyDates: { title: string; occurredOn: Date | null }[];
  /** The case strategy's STRATEGY / TODO items (CaseStrategySvc). */
  strategy: { kind: string; label: string }[];
  /** Case.language — the map is written in it. */
  language: string;
  /** UK tenant only — read by buildUKMindMapDocumentsPrompt. */
  ukJurisdiction?: string | null;
}

/** Output tag CaseMindMapSvc reads the tree from — the same one extractMindMap already parses. */
export const MIND_MAP_DOCUMENTS_TAG = "MINDMAP";

/** Everything below the ROLE line — shared by the PH and UK builders so the tree shape the
 * parser and the five fixed branch ids (MIND_MAP_FIXED_BRANCH_IDS) depend on can't drift. */
export function mindMapDocumentsPromptBody(d: MindMapDocumentsPromptData): string {
  const list = (items: string[]) => (items.length ? items.map((s) => `- ${s}`).join("\n") : "(none yet)");
  const date = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : "undated");

  return `## TASK
Build the case strategy mind map for this case from its documents. It is the lawyer's one-page
view of the case: what law it rests on, the facts that matter, what is being sought, what could
go wrong, and what to do next — every point specific to this case and traceable to a document.

## SHAPE
- Root: {"id": "root", "label": <the case in at most 6 words>, "isRoot": true}.
- Exactly these five first-level branches, in this order, with these ids (labels may be
  translated into the output language):
  "legalBasis" (Legal Basis), "keyFacts" (Key Facts), "remedies" (Remedies), "risks" (Risks),
  "nextSteps" (Next Steps).
- Below them, 2 to 4 children per node, going 3 to 4 levels below the root where the documents
  support it — e.g. Legal Basis → cause of action → element to prove → the evidence for it;
  Risks → specific risk → mitigation; Next Steps → step → sub-task or deadline.
- At most ${Math.min(MIND_MAP_LIMITS.maxNodes, 80)} nodes in total and never more than ${MIND_MAP_LIMITS.maxDepth} levels below the root.
  Where a branch could clearly go further but you stopped, set "hasMore": true on that node.
- A branch the documents say nothing about gets one child saying what is missing (e.g.
  "No demand letter in the file") rather than invented content.

## EVERY NODE BELOW THE FIRST LEVEL
- "label": at most 8 words, specific (names, dates, sums, sections), never a generic category.
- "description": 1-3 sentences of the actual reasoning or evidence, naming the document by its
  name (never its id). Markdown allowed.
- "sources": the documents it comes from, as [{"documentId": "<id from the list below>", "page": <number or null>}].
  Use only ids from the DOCUMENTS list. Omit "sources" when the point isn't from a document.
- "children": [] on leaves.
- Do not invent parties, amounts, dates, or authorities that are not in the documents.

## OUTPUT LANGUAGE
${d.language}

## DOCUMENTS
${d.docs.map((doc) => `- \`${doc.id}\` — ${doc.name}`).join("\n")}

## WHAT THE CASE ANALYSIS HAS FOUND SO FAR (use it, but the documents win on any conflict)
Findings:
${list(d.findings.map((f) => `${f.category}: ${f.label}`))}

Key dates:
${list(d.keyDates.map((k) => `${date(k.occurredOn)} — ${k.title}`))}

Strategy and to-dos:
${list(d.strategy.map((s) => `${s.kind}: ${s.label}`))}

## OUTPUT
Reply with this block and nothing else. No prose, no markdown fences, no [Sources], no related cases.

[${MIND_MAP_DOCUMENTS_TAG}]
{"id": "root", "label": "...", "isRoot": true, "children": [{"id": "legalBasis", "label": "Legal Basis", "children": [...]}, ...]}
[/${MIND_MAP_DOCUMENTS_TAG}]`;
}

export function buildMindMapDocumentsPrompt(d: MindMapDocumentsPromptData): string {
  return `[legal ai]

## ROLE
You are a Philippine litigation lawyer's research assistant, building the case strategy map from the attached case documents.

${mindMapDocumentsPromptBody(d)}`;
}
