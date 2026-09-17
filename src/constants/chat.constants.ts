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

// The title prompts (chat-title.prompt.ts, UK and PH) instruct the model to output exactly this
// token — instead of the usual "[Legal Area]: [Specific Issue]" format — when the user's message
// is gibberish, incoherent, or otherwise gives it nothing to confidently categorize. Without an
// explicit escape hatch like this, a rigid required-format prompt has no way to express "I don't
// know" and instead pattern-completes a plausible-looking (but fabricated) legal category even
// for nonsense input. ChatSvc.generateAndSaveTitle checks for this exact value and leaves the
// consultation untitled (falls back to the frontend's own "Untitled consultation" copy) instead
// of saving it as a literal title.
export const UNCLEAR_TITLE_SENTINEL = "UNCLEAR_INPUT";
