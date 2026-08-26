export const SESSION_RETRIES = 3;
export const RETRY_DELAY_MS = 1000;
export const LEGAL_TAG = "[legal ai]";
/** Legal persona sends `__END__` first, then `[STRUCTURED_DATA]` (timeline + mind map)
 * on a second LLM call, then `[DONE]`. Wait this long after `__END__` for that frame. */
export const STRUCTURED_DATA_WAIT_MS = 45_000;

// Case-only feature (ilovelawyer-app/CONTEXT.md's Mind Map entry) — only ever appended when
// the message belongs to a case-linked Conversation. See streamChatWonderMessage's `caseId`
// param and docs/mind-map-generation-backend-handoff.md in ilovelawyer-app.
export const MINDMAP_RULE = `

When the user asks you to generate, build, update, or show a visual case strategy map, mind map, or
case structure diagram, include a tag in your response in this exact format:

[MINDMAP]{"id":"root","label":"Case Analysis","isRoot":true,"children":[{"id":"...","label":"...","description":"...","children":[]}]}[/MINDMAP]

Rules:
- Output valid JSON only inside the tags — no markdown code fences, no comments.
- Root object: "id" ("root"), "label" (short title), "isRoot": true, "children" (array).
- Each child: "id" (unique string), "label" (short title), "description" (optional, longer
  explanation, markdown allowed), "children" (array — empty if it's a leaf).
- Nest as many levels as the case reasonably supports.
- If the case doesn't have enough established facts yet, still output a minimal tree (a root plus one
  or two children such as "Facts not yet established") instead of only explaining in prose why you
  can't build a full one — the prose explanation can still stay, the tag should be there either way.
- Do NOT draw the map as ASCII art, a table, or any other plain-text representation — only the tagged
  JSON block renders as a diagram; everything outside the tag is shown to the user as ordinary text,
  and the tag itself is stripped out before they see it.
- If the user did not ask for a visual map, do not include this tag at all.`;
