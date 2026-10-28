import { openIntakeField, sealIntakeField } from "./intake-field-crypto";
import logger from "./logger";

/** Sealing for IntakeMessage text, via intake-field-crypto.ts — the intake pipeline's own key and
 * implementation, never field-crypto.ts/message-content.ts (those seal the lawyer side's Message
 * table). Sealed only while INTAKE_FIELD_ENCRYPTION_ENABLED is on; reading never depends on the
 * switch, and text that was never sealed reads back as it is.
 *
 * Labels are `<Model>.<field>`, bound into each value. Every place that writes or returns
 * IntakeMessage.content or IntakeMessage.pendingReplyContent goes through these. */

export const INTAKE_CONTENT = "IntakeMessage.content";
export const INTAKE_PENDING_REPLY = "IntakeMessage.pendingReplyContent";

export const sealIntakeMessageContent = (plain: string): string => sealIntakeField(plain, INTAKE_CONTENT, true);

export const sealIntakePendingReply = (plain: string): string => sealIntakeField(plain, INTAKE_PENDING_REPLY, true);

type IntakeMessageText = { id?: string; content?: string; pendingReplyContent?: string | null };

/** `row` with its message text opened, or null when its content is sealed and cannot be opened: that
 * one message is left out so the rest of the thread still loads. */
export function openIntakeMessage<T extends IntakeMessageText>(row: T): T | null {
  const out: T = { ...row };
  if (typeof row.content === "string") {
    const content = openIntakeField(row.content, INTAKE_CONTENT);
    if (content === null) {
      logger.warn("Intake message left out: its content is sealed and cannot be opened", { messageId: row.id });
      return null;
    }
    out.content = content;
  }
  if (typeof row.pendingReplyContent === "string") {
    out.pendingReplyContent = openIntakeField(row.pendingReplyContent, INTAKE_PENDING_REPLY);
  }
  return out;
}

/** `rows` with each message opened and any that cannot be left out. */
export function openIntakeMessages<T extends IntakeMessageText>(rows: T[]): T[] {
  return rows.flatMap((row) => {
    const opened = openIntakeMessage(row);
    return opened ? [opened] : [];
  });
}
