/** Extra material a chat-title prompt can use when the user's message alone is too vague to title
 * — e.g. "what are these documents?" with six files attached. Both are optional. */
export interface ChatTitleContext {
  /** Names of the files attached to the message being titled. */
  attachmentNames?: string[];
  /** Start of the assistant's reply — only on the post-reply retry (see ChatSvc.titleAfterReply). */
  replyExcerpt?: string;
}

const MAX_ATTACHMENT_NAMES = 10;
const REPLY_EXCERPT_CHARS = 1500;

/** The "Attached files" / "Assistant replied" lines appended after "User asked:" in the PH and
 * UK title prompts; empty when there's no context. */
export function buildTitleContextLines(context: ChatTitleContext): string {
  let lines = "";
  const names = (context.attachmentNames ?? []).filter(Boolean).slice(0, MAX_ATTACHMENT_NAMES);
  if (names.length > 0) lines += `Attached files: ${names.join("; ")}\n`;
  const reply = context.replyExcerpt?.trim();
  if (reply) lines += `Assistant replied (excerpt): ${reply.slice(0, REPLY_EXCERPT_CHARS)}\n`;
  return lines;
}
