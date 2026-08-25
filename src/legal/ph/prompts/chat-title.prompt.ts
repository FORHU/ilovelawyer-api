const TITLE_MAX_CHARS = 60;
const TITLE_INPUT_CHARS = 500;

export function buildPHChatTitlePrompt(userMessage: string): string {
  return (
    `Create a concise title for a Philippine legal consultation.\n` +
    `Format: [Legal Area]: [Specific Issue] — for example: "Philippine Labor Law: Illegal Dismissal", "Family Code: Custody Rights", "Criminal Law: Estafa"\n` +
    `Rules: plain text only, no markdown, no quotes, no trailing period, max ${TITLE_MAX_CHARS} characters.\n` +
    `User asked: ${userMessage.slice(0, TITLE_INPUT_CHARS)}\n` +
    `Output only the title, nothing else.`
  );
}
