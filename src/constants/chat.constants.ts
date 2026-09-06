export const TITLE_CACHE_TTL = 60 * 60 * 24 * 7; // 7 days
export const RESPONSE_CACHE_TTL = 60 * 15; // 15 minutes
export const TITLE_MAX_CHARS = 60; // max title length (matches frontend truncation)
export const CHAT_WONDER_SESSION_TTL_S = 60 * 60; // match chat-wonder's in-memory session TTL

// Used in place of the user's message text (title generation, AI prompt, cache key) when a
// message carries attachments but no typed text — content itself stays a stored empty string
// (see ADR: locale-independent "no content" signal for the frontend to render nothing), so this
// fixed, non-localized stand-in is what the AI actually sees instead.
export const ATTACHMENT_ONLY_PROMPT =
  "The user attached one or more documents without any additional message. Review the attached document(s) and respond accordingly.";
