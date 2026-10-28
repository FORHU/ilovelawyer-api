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
/** Benchmark-only: skip pgvector ranking and do not send case_document_chunk_ids, so
 * chat-wonder's get_case_document BM25 truncation path can run. Default off. */
export const OMIT_EMBEDDING_RANKING = process.env.OMIT_EMBEDDING_RANKING === "true";
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
// param. The diagram itself no longer comes from the answer: it used to ask for an inline
// [MINDMAP]{...} tag here, but chat.service.ts always preferred the separate
// `[STRUCTURED_DATA]` tree (chat-wonder's _generate_structured_data), so that inline tree was
// asked for on every map request and then thrown away. What's left only keeps the answer from
// drawing its own text version of the map next to the real diagram.
export const MINDMAP_RULE = `

When the user asks you to generate, build, update, or show a visual case strategy map, mind map, or
case structure diagram, the diagram is generated and shown to them separately from your reply. Do NOT
draw the map yourself as ASCII art, a tree of bullet points, a table, or any other plain-text
representation, and do not output JSON for it. Answer with the legal analysis the map should reflect.`;
