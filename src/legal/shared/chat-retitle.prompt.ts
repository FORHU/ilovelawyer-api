import { KEEP_TITLE_SENTINEL, TITLE_MAX_CHARS } from "../../constants";

const MESSAGE_CHARS = 300;

/** Asks whether an AI-generated consultation title still fits after a new message, and for a
 * better one if the subject has clearly shifted or sharpened. Biased hard toward KEEP so titles
 * don't churn on every follow-up. Shared by PH and UK — only the jurisdiction label differs. */
export function buildChatRetitlePrompt(p: {
  jurisdiction: string;
  currentTitle: string;
  /** The user's recent messages, oldest first — the last one is the new message. */
  userMessages: string[];
  attachmentNames: string[];
}): string {
  const messages = p.userMessages.map((m, i) => `${i + 1}. ${m.replace(/\s+/g, " ").slice(0, MESSAGE_CHARS)}`).join("\n");
  return (
    `You maintain the title of a ${p.jurisdiction} legal consultation as the conversation develops.\n` +
    `Current title: ${p.currentTitle}\n` +
    `The user's messages so far, oldest first (the last one is new):\n${messages}\n` +
    (p.attachmentNames.length > 0 ? `Files attached to the new message: ${p.attachmentNames.slice(0, 10).join("; ")}\n` : "") +
    `Decide whether the current title still describes what this consultation is mainly about.\n` +
    `- If it still fits, output exactly ${KEEP_TITLE_SENTINEL}. This is the usual answer: follow-ups, clarifications, thanks, small talk, gibberish and side questions never change the title.\n` +
    `- Change it only when the main subject has clearly shifted to something else, or become clearly more specific than the title (e.g. "Property Law: General Overview" -> "Property Law: Boundary Dispute With Neighbour" once the user describes their actual dispute).\n` +
    `- A new title uses the format [Legal Area]: [Specific Issue] ("General Question: [Topic]" for a real non-legal question — never for a greeting) — plain text, no markdown, no quotes, no trailing period, max ${TITLE_MAX_CHARS} characters.\n` +
    `Output only ${KEEP_TITLE_SENTINEL} or the new title, nothing else.`
  );
}
