import { openField, sealField } from "./field-crypto";
import logger from "./logger";

/** Sealing for chat message text (issue #277), with the same helper and key as notes and document
 * chunks (utils/field-crypto.ts). Sealed only while FIELD_ENCRYPTION_ENABLED is on; reading never
 * depends on the switch, and text that was never sealed reads back as it is.
 *
 * Labels are `<Model>.<field>`, bound into each value, so text sealed for one field does not open
 * as another. Every repository call that writes or returns Message.content or
 * Message.pendingReplyContent goes through these. */

export const CONTENT = "Message.content";
export const PENDING_REPLY = "Message.pendingReplyContent";

export const sealMessageContent = (plain: string): string => sealField(plain, CONTENT, true);

export const sealPendingReply = (plain: string): string => sealField(plain, PENDING_REPLY, true);

type MessageText = { id?: string; content?: string; pendingReplyContent?: string | null };

/** `row` with its message text opened, or null when its content is sealed and cannot be opened (no
 * matching key, or tampered): that one message is left out so the rest of the chat still loads.
 * The checkpointed partial reply is scratch text for a turn still generating, so one that cannot
 * be opened is just treated as absent. Fields the row does not carry are left alone. */
export function openMessage<T extends MessageText>(row: T): T | null {
  const out: T = { ...row };
  if (typeof row.content === "string") {
    const content = openField(row.content, CONTENT);
    if (content === null) {
      logger.warn("Message left out: its content is sealed and cannot be opened", { messageId: row.id });
      return null;
    }
    out.content = content;
  }
  if (typeof row.pendingReplyContent === "string") {
    out.pendingReplyContent = openField(row.pendingReplyContent, PENDING_REPLY);
  }
  return out;
}

/** `rows` with each message opened and any that cannot be left out. */
export function openMessages<T extends MessageText>(rows: T[]): T[] {
  return rows.flatMap((row) => {
    const opened = openMessage(row);
    return opened ? [opened] : [];
  });
}
