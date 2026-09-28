export interface MindMapExpandPromptData {
  caseName?: string | null;
  actionType?: string | null;
  /** Labels from the root down to (and including) the node being expanded. */
  path: string[];
  node: { label: string; description?: string };
  /** The node's siblings' labels — so the new children don't repeat what's beside it. */
  siblings: string[];
  /** Children the node already has, when it's being expanded a second time. */
  existingChildren: string[];
  /** How many children to ask for, already capped to what fits under MIND_MAP_LIMITS. */
  count: number;
  /** UK tenant only — read by buildUKMindMapExpandPrompt. */
  ukJurisdiction?: string | null;
  /** The case's documents — given on the case map only, whose points cite a document and page
   * (and are then checked against it by Jev). Chat maps don't cite. */
  documents?: { id: string; name: string }[];
}

/** Output tag MindMapSvc parses the new children from (see parseExpandedChildren). */
export const MIND_MAP_CHILDREN_TAG = "MINDMAP_CHILDREN";

/** Everything below the ROLE line — shared by the PH and UK builders so the output block the
 * parser depends on can't drift between them. */
export function mindMapExpandPromptBody(d: MindMapExpandPromptData): string {
  const list = (items: string[]) => (items.length ? items.map((s) => `- ${s}`).join("\n") : "(none)");
  const caseLine = [d.caseName, d.actionType].filter(Boolean).join(" — ");

  return `## TASK
The lawyer is looking at a case strategy mind map and asked to break one node down further.
Add ${d.count} new child nodes under the node below. Each child is one specific, concrete point
that belongs under that node — a fact, an element to prove, a piece of evidence, a specific risk,
a concrete step — drawn from the attached case documents wherever they cover it.

${caseLine ? `## CASE\n${caseLine}\n\n` : ""}## WHERE THE NODE SITS
${d.path.join(" › ")}

## NODE TO EXPAND
${d.node.label}${d.node.description ? `\n${d.node.description}` : ""}

## ALREADY BESIDE IT (do not repeat)
${list(d.siblings)}

## ALREADY UNDER IT (do not repeat — add different points)
${list(d.existingChildren)}

${d.documents?.length ? `## DOCUMENTS\n${d.documents.map((doc) => `- \`${doc.id}\` — ${doc.name}`).join("\n")}\n\n` : ""}## RULES
- Exactly ${d.count} children, or fewer if the documents and the node genuinely support fewer. Never pad.
- "label": at most 8 words, specific (names, dates, sums, sections), not a generic category.
- "description": 1-3 sentences of the actual reasoning or evidence, citing the document or authority
  it comes from where there is one. Markdown allowed.
- Do not invent parties, amounts, dates, or authorities that are not in the documents.
- Write in the same language as the node labels above.
- Leaves only: no nested "children".${
    d.documents?.length
      ? `\n- "sources": the documents each point comes from, as [{"documentId": "<id from DOCUMENTS>", "page": <number or null>}].\n  Use only ids from the DOCUMENTS list; omit "sources" when a point isn't from a document.`
      : ""
  }

## OUTPUT
Reply with this block and nothing else. No prose, no markdown fences, no [Sources], no related cases.

[${MIND_MAP_CHILDREN_TAG}]
${d.documents?.length ? `[{"label": "...", "description": "...", "sources": [{"documentId": "...", "page": 1}]}]` : `[{"label": "...", "description": "..."}]`}
[/${MIND_MAP_CHILDREN_TAG}]`;
}

export function buildMindMapExpandPrompt(d: MindMapExpandPromptData): string {
  return `[legal ai]

## ROLE
You are a Philippine litigation lawyer's research assistant, filling in one branch of their case strategy map.

${mindMapExpandPromptBody(d)}`;
}
