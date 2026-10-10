/**
 * Seals the notes that already exist on privileged evidence (#343): the notes of every matrix item
 * whose privilegeStatus is not NONE, and the notes of its custody events. New writes are sealed by
 * EvidenceRepo on their own; this covers what was stored before the switch was turned on. With
 * --reverse it puts every sealed note (privileged or not) back to plain text.
 *
 * Seal:     needs FIELD_ENCRYPTION_ENABLED=true and FIELD_ENCRYPTION_KEY.
 * Reverse:  needs the key (FIELD_ENCRYPTION_KEY, plus FIELD_ENCRYPTION_OLD_KEYS if needed). Set
 *           FIELD_ENCRYPTION_ENABLED=false first, or privileged notes are sealed again on the next edit.
 *
 * Always safe to rerun and to stop: a row already in the wanted form is skipped, and sealed text
 * that cannot be opened (its key is gone) is counted and left exactly as it is.
 *
 * It is compiled with the app, so it also runs inside the production container:
 *   Dry run (default):   node dist/scripts/encrypt-privileged-notes.js
 *   Do it:               node dist/scripts/encrypt-privileged-notes.js --apply
 *   Undo it:             node dist/scripts/encrypt-privileged-notes.js --reverse --apply
 * From a checkout: npx ts-node src/scripts/encrypt-privileged-notes.ts [same options]
 */
import * as dotenv from "dotenv";
dotenv.config();

import prisma from "../lib/prisma";
import { FIELD_ENCRYPTION_ENABLED, FIELD_ENCRYPTION_KEY, FIELD_ENCRYPTION_OLD_KEYS } from "../config";
import { isEncryptedField, openField } from "../utils/field-crypto";
import EvidenceRepo from "../repositories/evidence.repository";

const BATCH = 100;
const MATRIX_NOTES = "EvidenceMatrixItem.notes";
const CUSTODY_NOTES = "EvidenceCustodyEvent.notes";

export interface NotesBackfillOptions {
  /** Without it nothing is written; the result still says what would change. */
  apply: boolean;
  /** Put sealed notes back to plain text instead of sealing plain ones. */
  reverse?: boolean;
}

export interface NotesBackfillResult {
  /** Items that had at least one note in the form being changed. */
  matched: number;
  /** Items rewritten (always 0 without apply). */
  changed: number;
  failed: number;
  /** Sealed notes that could not be opened and were left alone (reverse only). */
  unreadable: number;
}

const needsSealing = (notes: string | null) => !!notes && !isEncryptedField(notes);

function assertConfigured(reverse: boolean): void {
  if (reverse) {
    if (!FIELD_ENCRYPTION_KEY && !FIELD_ENCRYPTION_OLD_KEYS) throw new Error("Set FIELD_ENCRYPTION_KEY (and FIELD_ENCRYPTION_OLD_KEYS if needed) so sealed notes can be opened; nothing was changed.");
    return;
  }
  if (!FIELD_ENCRYPTION_ENABLED || !FIELD_ENCRYPTION_KEY) throw new Error("Set FIELD_ENCRYPTION_ENABLED=true and FIELD_ENCRYPTION_KEY first; nothing was changed.");
}

export async function backfillNotes(options: NotesBackfillOptions, log: (line: string) => void = console.log): Promise<NotesBackfillResult> {
  const reverse = options.reverse === true;
  assertConfigured(reverse);
  if (reverse && FIELD_ENCRYPTION_ENABLED) log("Warning: FIELD_ENCRYPTION_ENABLED is still true, so privileged notes will be sealed again on their next edit. Turn it off for a lasting undo.");

  const result: NotesBackfillResult = { matched: 0, changed: 0, failed: 0, unreadable: 0 };
  let lastId = "";

  for (;;) {
    // Paged by id rather than by a cursor: in reverse mode a row stops matching once it is rewritten.
    const items = await prisma.evidenceMatrixItem.findMany({
      where: {
        id: { gt: lastId },
        ...(reverse
          ? { OR: [{ notes: { startsWith: "enc1:" } }, { custodyEvents: { some: { notes: { startsWith: "enc1:" } } } }] }
          : { privilegeStatus: { not: "NONE" } }),
      },
      include: { custodyEvents: { select: { id: true, notes: true } } },
      orderBy: { id: "asc" },
      take: BATCH,
    });
    if (items.length === 0) break;
    lastId = items[items.length - 1]!.id;

    for (const item of items) {
      try {
        if (reverse) {
          const wanted = [
            { id: item.id, stored: item.notes, label: MATRIX_NOTES, custody: false },
            ...item.custodyEvents.map((event) => ({ id: event.id, stored: event.notes, label: CUSTODY_NOTES, custody: true })),
          ].filter((n) => isEncryptedField(n.stored));
          if (wanted.length === 0) continue;
          result.matched += 1;
          const opened = wanted.map((n) => ({ ...n, plain: openField(n.stored, n.label) }));
          result.unreadable += opened.filter((n) => n.plain === null).length;
          const writable = opened.filter((n) => n.plain !== null);
          if (!options.apply || writable.length === 0) continue;
          await prisma.$transaction(async (tx) => {
            for (const n of writable) {
              if (n.custody) await tx.evidenceCustodyEvent.update({ where: { id: n.id }, data: { notes: n.plain } });
              else await tx.evidenceMatrixItem.update({ where: { id: n.id }, data: { notes: n.plain } });
            }
          });
          result.changed += 1;
        } else {
          if (!needsSealing(item.notes) && !item.custodyEvents.some((event) => needsSealing(event.notes))) continue;
          result.matched += 1;
          if (!options.apply) continue;
          // An edit that sends nothing: the repository moves the item's notes and custody notes into the form its status needs.
          await EvidenceRepo.upsertMatrix(item.caseId, item.documentId, {});
          result.changed += 1;
        }
      } catch (err) {
        result.failed += 1;
        log(`Failed on item ${item.id}: ${(err as Error).message}`);
      }
    }
  }
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const options: NotesBackfillOptions = { apply: args.includes("--apply"), reverse: args.includes("--reverse") };
  const what = options.reverse ? "with sealed notes (to be put back to plain text)" : "privileged items with notes not yet sealed";

  try {
    const result = await backfillNotes(options);
    console.log(`Items ${what}: ${result.matched}.`);
    if (result.unreadable) console.log(`Could not be opened with the configured key, left untouched: ${result.unreadable}.`);
    if (options.apply) console.log(`${options.reverse ? "Unsealed" : "Sealed"}: ${result.changed}. Failed: ${result.failed}.`);
    else console.log("Dry run: nothing was changed. Run again with --apply to do it.");
    if (result.failed) process.exitCode = 1;
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
    process.exit();
  }
}

if (require.main === module) void main();
