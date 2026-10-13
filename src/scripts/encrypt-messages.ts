/**
 * Seals the text of chat messages that were stored before field encryption covered them (#277,
 * #278): Message.content and Message.pendingReplyContent. New messages are sealed as they are
 * written (ChatRepo.createMessage, checkpointPendingReply); this covers the rest. Or puts it back to
 * plain text with --reverse, or onto the current key with --rekey.
 *
 * Seal:     needs FIELD_ENCRYPTION_ENABLED=true and FIELD_ENCRYPTION_KEY.
 * Reverse:  needs the key (FIELD_ENCRYPTION_KEY, plus FIELD_ENCRYPTION_OLD_KEYS if messages were
 *           sealed under an older one). Set FIELD_ENCRYPTION_ENABLED=false first, or new messages
 *           will be sealed again straight away.
 * Rekey:    puts every message sealed under an EARLIER key under the current FIELD_ENCRYPTION_KEY, so
 *           one key is enough afterwards. Needs FIELD_ENCRYPTION_KEY plus the earlier keys in
 *           FIELD_ENCRYPTION_OLD_KEYS for this one run only (pass them to docker exec with -e; they do
 *           not need to be in the server's settings). Run it until it reports 0 left, then remove them.
 *
 * Always safe to rerun and to stop: a field already in the wanted form is skipped, messages are
 * processed in small batches in id order, only the two text columns change, a message is only written
 * if it is still exactly as it was read (so a concurrent edit is never overwritten), and a message
 * that cannot be opened (its key is gone) is counted and left exactly as it is, never overwritten.
 * Reading never depends on the order: unsealed text reads back as it is, before and after this runs.
 *
 * It is compiled with the app, so it also runs inside the production container:
 *   Dry run (default):        node dist/scripts/encrypt-messages.js
 *   Do it:                    node dist/scripts/encrypt-messages.js --apply
 *   Undo it:                  node dist/scripts/encrypt-messages.js --reverse --apply
 *   One key only:             node dist/scripts/encrypt-messages.js --rekey --apply
 *   One consultation only:    ... --consultation <consultationId>
 * From a checkout: npx ts-node src/scripts/encrypt-messages.ts [same options]
 *
 * Backups taken before this run still hold the plain text until they expire.
 */
import * as dotenv from "dotenv";
dotenv.config();

import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import { FIELD_ENCRYPTION_ENABLED, FIELD_ENCRYPTION_KEY, FIELD_ENCRYPTION_OLD_KEYS } from "../config";
import { currentKeyId, encryptField, openField, sealField } from "../utils/field-crypto";
import { CONTENT, PENDING_REPLY } from "../utils/message-content";

// Small, because a message can be long and Prisma fails on very large single results.
const BATCH = 200;
const SEALED = "enc1:";

type Field = "content" | "pendingReplyContent";
type Texts = { content: string; pendingReplyContent: string | null };

export interface MessageBackfillOptions {
  /** Without it nothing is written; the result still says what would change. */
  apply: boolean;
  /** Put sealed messages back to plain text instead of sealing plain ones. */
  reverse?: boolean;
  /** Re-seal messages sealed under an earlier key with the current key. */
  rekey?: boolean;
  /** Limit the run to one consultation. */
  consultationId?: string;
}

export interface MessageBackfillResult {
  /** Messages that were in the form being changed (and could be). */
  matched: number;
  /** Messages actually rewritten (always 0 without apply). */
  changed: number;
  /** Sealed messages that could not be opened and were left alone (reverse and rekey only). */
  unreadable: number;
}

/** Throws, without touching anything, when the settings cannot do what was asked. */
function assertConfigured(reverse: boolean, rekey: boolean): void {
  if (rekey) {
    if (reverse) throw new Error("Use either --reverse or --rekey, not both; nothing was changed.");
    if (currentKeyId() === null) throw new Error("Set FIELD_ENCRYPTION_KEY (and the earlier keys in FIELD_ENCRYPTION_OLD_KEYS) first; nothing was changed.");
    return;
  }
  if (reverse) {
    if (!FIELD_ENCRYPTION_KEY && !FIELD_ENCRYPTION_OLD_KEYS) throw new Error("Set FIELD_ENCRYPTION_KEY (and FIELD_ENCRYPTION_OLD_KEYS if needed) so sealed messages can be opened; nothing was changed.");
    return;
  }
  if (!FIELD_ENCRYPTION_ENABLED || !FIELD_ENCRYPTION_KEY) throw new Error("Set FIELD_ENCRYPTION_ENABLED=true and FIELD_ENCRYPTION_KEY first; nothing was changed.");
}

/** A field with text in it that is not sealed yet. Empty text is left alone, so a blank file-only
 * message stays blank and a rerun still finds nothing. */
const unsealed = (field: Field) => ({ [field]: { not: "" }, NOT: { [field]: { startsWith: SEALED } } }) as Prisma.MessageWhereInput;

const sealed = (field: Field) => ({ [field]: { startsWith: SEALED } }) as Prisma.MessageWhereInput;

/** Sealed, but under an earlier key: `enc1:<this key's id>:...` is the current one. */
const sealedUnderEarlierKey = (field: Field, currentPrefix: string) =>
  ({ [field]: { startsWith: SEALED }, NOT: { [field]: { startsWith: currentPrefix } } }) as Prisma.MessageWhereInput;

/** `row`'s two fields in the wanted form, or null when one needs opening and cannot be: then the
 * whole message is left exactly as it is. */
function wanted(row: Texts, reverse: boolean, rekey: boolean, currentPrefix: string): Texts | null {
  const one = (value: string | null, label: string): { text: string | null } | null => {
    if (!value) return { text: value };
    const isSealed = value.startsWith(SEALED);
    if (reverse || rekey) {
      if (!isSealed || (rekey && value.startsWith(currentPrefix))) return { text: value };
      const plain = openField(value, label);
      if (plain === null) return null;
      return { text: rekey ? encryptField(plain, label) : plain };
    }
    return { text: isSealed ? value : sealField(value, label, true) };
  };
  const content = one(row.content, CONTENT);
  const pending = one(row.pendingReplyContent, PENDING_REPLY);
  return content && pending ? { content: content.text as string, pendingReplyContent: pending.text } : null;
}

export async function backfillMessages(options: MessageBackfillOptions, log: (line: string) => void = console.log): Promise<MessageBackfillResult> {
  const reverse = options.reverse === true;
  const rekey = options.rekey === true;
  assertConfigured(reverse, rekey);
  if (reverse && FIELD_ENCRYPTION_ENABLED) log("Warning: FIELD_ENCRYPTION_ENABLED is still true, so new messages will be sealed again. Turn it off for a lasting undo.");

  const currentPrefix = `${SEALED}${currentKeyId() ?? ""}:`;
  const match = (field: Field) => (rekey ? sealedUnderEarlierKey(field, currentPrefix) : reverse ? sealed(field) : unsealed(field));
  let lastId = "";
  const result: MessageBackfillResult = { matched: 0, changed: 0, unreadable: 0 };

  for (;;) {
    const rows = await prisma.message.findMany({
      where: {
        id: { gt: lastId },
        ...(options.consultationId ? { consultationId: options.consultationId } : {}),
        OR: [match("content"), match("pendingReplyContent")],
      },
      orderBy: { id: "asc" },
      take: BATCH,
      select: { id: true, content: true, pendingReplyContent: true },
    });
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1]!.id;

    const updates: { row: (typeof rows)[number]; to: Texts }[] = [];
    for (const row of rows) {
      const to = wanted(row, reverse, rekey, currentPrefix);
      if (to === null) result.unreadable += 1;
      else updates.push({ row, to });
    }
    result.matched += updates.length;
    if (!options.apply) continue;

    for (const { row, to } of updates) {
      // Only a message still exactly as it was read is written, so a concurrent edit is never overwritten.
      const { count } = await prisma.message.updateMany({
        where: { id: row.id, content: row.content, pendingReplyContent: row.pendingReplyContent },
        data: to,
      });
      result.changed += count;
    }
    if (result.changed % 5000 < BATCH) log(`  ...${result.changed} messages done`);
  }
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const consultationFlag = args.indexOf("--consultation");
  const consultationId = consultationFlag >= 0 ? args[consultationFlag + 1] : undefined;
  if (consultationFlag >= 0 && !consultationId) {
    console.error("--consultation needs a consultation id; nothing was changed.");
    process.exit(1);
  }
  const options: MessageBackfillOptions = { apply: args.includes("--apply"), reverse: args.includes("--reverse"), rekey: args.includes("--rekey"), consultationId };
  const scope = consultationId ? `consultation ${consultationId}` : "all consultations";
  const verb = options.rekey ? "sealed under an earlier key (to be re-sealed with the current key)" : options.reverse ? "sealed (to be put back to plain text)" : "not yet sealed";

  try {
    const result = await backfillMessages(options);
    console.log(`Messages in ${scope} ${verb}: ${result.matched}.`);
    if (result.unreadable) console.log(`Could not be opened with the configured key, left untouched: ${result.unreadable}.`);
    if (options.apply) console.log(`${options.rekey ? "Re-sealed" : options.reverse ? "Unsealed" : "Sealed"}: ${result.changed}.`);
    else console.log("Dry run: nothing was changed. Run again with --apply to do it.");
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
    process.exit();
  }
}

if (require.main === module) void main();
