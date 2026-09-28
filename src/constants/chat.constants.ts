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

// Saved as a PROVISIONAL title when a consultation opens with gibberish — better than
// "Untitled consultation", and replaced as soon as the user sends something real.
export const PROVISIONAL_UNCLEAR_TITLE = "Unclear Request";

// The title prompts output this for a greeting/pleasantry/small talk ("hi", "thanks") — nothing to
// title yet, but not "unclear" either. Saved as a PROVISIONAL "New Consultation" instead of being
// forced into a fake "General Question: ..." title; the first real question replaces it.
export const SMALL_TALK_TITLE_SENTINEL = "SMALL_TALK";
export const PROVISIONAL_GREETING_TITLE = "New Consultation";

// What the re-title prompt (legal/shared/chat-retitle.prompt.ts) outputs when the current title
// still fits — the usual answer, since most follow-ups don't change what a consultation is about.
export const KEEP_TITLE_SENTINEL = "KEEP_TITLE";
