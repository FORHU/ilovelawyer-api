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
// replyAudioTimings.text is a markdown-stripped DUPLICATE of the same assistant reply `content`
// already seals — without its own sealing, turning encryption on would still leave every voice
// reply's full text sitting in the clear in this JSON column, defeating the point of sealing
// `content` at all. Its own label (not INTAKE_CONTENT): a different field, bound into its own AEAD
// tag, same as every other sealed field here.
export const INTAKE_REPLY_AUDIO_TIMINGS_TEXT = "IntakeMessage.replyAudioTimings.text";

export const sealIntakeMessageContent = (plain: string): string => sealIntakeField(plain, INTAKE_CONTENT, true);

export const sealIntakePendingReply = (plain: string): string => sealIntakeField(plain, INTAKE_PENDING_REPLY, true);

export const sealReplyAudioTimingsText = (plain: string): string => sealIntakeField(plain, INTAKE_REPLY_AUDIO_TIMINGS_TEXT, true);

type IntakeMessageText = {
  id?: string;
  content?: string;
  pendingReplyContent?: string | null;
  replyAudioTimings?: unknown;
};

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
  const timings = row.replyAudioTimings;
  if (timings && typeof timings === "object" && typeof (timings as { text?: unknown }).text === "string") {
    const text = openIntakeField((timings as { text: string }).text, INTAKE_REPLY_AUDIO_TIMINGS_TEXT);
    // Opened text standing in for the rest of the payload's shape as it already is — never
    // reconstructed field-by-field, so a shape change to ReplyAudioTimings needs no change here.
    out.replyAudioTimings = text === null ? null : { ...(timings as object), text };
    if (text === null) {
      logger.warn("Intake message: replyAudioTimings.text is sealed and cannot be opened, dropping the player's transcript", { messageId: row.id });
    }
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
