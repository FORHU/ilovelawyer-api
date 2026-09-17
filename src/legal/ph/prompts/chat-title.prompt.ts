import { TITLE_MAX_CHARS, UNCLEAR_TITLE_SENTINEL } from "../../../constants";

const TITLE_INPUT_CHARS = 500;

export function buildPHChatTitlePrompt(userMessage: string): string {
  return (
    `Create a concise title for a Philippine legal consultation.\n` +
    `Format: [Legal Area]: [Specific Issue] — for example: "Philippine Labor Law: Illegal Dismissal", "Family Code: Custody Rights", "Criminal Law: Estafa"\n` +
    `Rules: plain text only, no markdown, no quotes, no trailing period, max ${TITLE_MAX_CHARS} characters.\n` +
    `If the message is gibberish, incoherent, or does not contain enough information to identify a specific legal area or issue, do NOT guess or invent one — output exactly "${UNCLEAR_TITLE_SENTINEL}" instead.\n` +
    `User asked: ${userMessage.slice(0, TITLE_INPUT_CHARS)}\n` +
    `Output only the title, nothing else.`
  );
}
