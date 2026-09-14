export const SESSION_RETRIES = 3;
export const RETRY_DELAY_MS = 1000;
/** GET /session-id has no work to do beyond opening a session — if Chat Wonder is unreachable
 * this should fail fast so SESSION_RETRIES actually retries within a bounded time instead of
 * each attempt hanging indefinitely (axios has no default timeout). */
export const CHAT_WONDER_SESSION_TIMEOUT_MS = 10_000;
/** callChatWonderRest has no server-sent progress (unlike the WS path), so a stalled or
 * unresponsive Chat Wonder call previously hung forever — axios sets no timeout by default.
 * Kept just under Cloudflare's ~100s edge timeout (see case-reconstruction.service.ts's
 * comment on the 524 this same blocking-REST pattern produces for longer generations) so a
 * dead connection fails on our side with a clear error instead of a raw proxy timeout. */
export const CHAT_WONDER_REST_TIMEOUT_MS = 90_000;

/** A case whose READY documents total at most this many characters of extracted text is sent to
 * chat-wonder whole (`case_document_texts`) alongside the ranked chunks, so the model has every
 * exhibit in full from the first turn and never mistakes a relevance-filtered fetch for the
 * complete document (Brackenmoor benchmark, D01 §25 / D20.3). 200k chars ≈ 50k tokens, under
 * chat-wonder's CASE_DOCUMENT_TOKEN_BUDGET. Larger bundles fall back to on-demand fetches. */
export const CASE_FULL_TEXT_INLINE_CHARS = Number(process.env.CASE_FULL_TEXT_INLINE_CHARS || 200_000);
export const LEGAL_TAG = "[legal ai]";
/** the_server.py::process_persona checks this exact tag before falling back to the
 * `jurisdiction` request field — sending it directly picks the `legal_uk` persona (its own
 * UK tool whitelist and prompt) without depending on that field at all. See
 * streamChatWonderMessage's withLegalTag, which picks between this and LEGAL_TAG. */
export const LEGAL_TAG_UK = "[legal ai uk]";
/** Legal persona sends `__END__` first, then runs `[STRUCTURED_DATA]` (timeline + mind
 * map), reasoning, and (when triggered) audio overview as concurrent lightweight LLM
 * calls before `[DONE]`. Wait this long after `__END__` for all of that. */
export const STRUCTURED_DATA_WAIT_MS = 60_000;

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
