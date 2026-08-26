// LEGAL_REVIEW_REQUIRED: see ../../ph/prompts/chat-title.prompt.ts for the PH counterpart.
const TITLE_MAX_CHARS = 60;
const TITLE_INPUT_CHARS = 500;

export function buildUKChatTitlePrompt(userMessage: string): string {
  return (
    `Create a concise title for an England & Wales legal consultation.\n` +
    `Format: [Legal Area]: [Specific Issue] — for example: "Employment Law: Unfair Dismissal", "Company Law: Director's Duties", "Contract Law: Breach of Warranty"\n` +
    `Rules: plain text only, no markdown, no quotes, no trailing period, max ${TITLE_MAX_CHARS} characters.\n` +
    `User asked: ${userMessage.slice(0, TITLE_INPUT_CHARS)}\n` +
    `Output only the title, nothing else.`
  );
}
