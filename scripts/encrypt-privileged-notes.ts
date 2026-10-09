/**
 * Seals the notes that already exist on privileged evidence (#343): the notes of every matrix item
 * whose privilegeStatus is not NONE, and the notes of its custody events. New writes are sealed by
 * EvidenceRepo on their own; this covers what was stored before the switch was turned on. It does
 * not re-seal values that are already sealed under an older key (rotation keeps those readable).
 *
 * Needs FIELD_ENCRYPTION_ENABLED=true and FIELD_ENCRYPTION_KEY. Safe to run again: a row that is
 * already sealed is left alone, and sealed text that cannot be opened is never overwritten.
 *
 * Dry run (default):  npx ts-node scripts/encrypt-privileged-notes.ts
 * Do it:              npx ts-node scripts/encrypt-privileged-notes.ts --apply
 */
import * as dotenv from "dotenv";
dotenv.config();

import prisma from "../src/lib/prisma";
import { FIELD_ENCRYPTION_ENABLED, FIELD_ENCRYPTION_KEY } from "../src/config";
import { isEncryptedField } from "../src/utils/field-crypto";
import EvidenceRepo from "../src/repositories/evidence.repository";

const BATCH = 100;
const apply = process.argv.includes("--apply");

const needsSealing = (notes: string | null) => !!notes && !isEncryptedField(notes);

async function main() {
  if (!FIELD_ENCRYPTION_ENABLED || !FIELD_ENCRYPTION_KEY) {
    console.error("Set FIELD_ENCRYPTION_ENABLED=true and FIELD_ENCRYPTION_KEY first; nothing was changed.");
    process.exit(1);
  }

  let cursor: string | undefined;
  let scanned = 0;
  let toSeal = 0;
  let sealed = 0;
  let failed = 0;

  for (;;) {
    const items = await prisma.evidenceMatrixItem.findMany({
      where: { privilegeStatus: { not: "NONE" } },
      include: { custodyEvents: { select: { notes: true } } },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (items.length === 0) break;
    cursor = items[items.length - 1]!.id;

    for (const item of items) {
      scanned += 1;
      if (!needsSealing(item.notes) && !item.custodyEvents.some((event) => needsSealing(event.notes))) continue;
      toSeal += 1;
      if (!apply) continue;
      try {
        // An edit that sends nothing: the repository moves the item's notes and custody notes into the form its status needs.
        await EvidenceRepo.upsertMatrix(item.caseId, item.documentId, {});
        sealed += 1;
      } catch (err) {
        failed += 1;
        console.error(`Failed on item ${item.id}:`, (err as Error).message);
      }
    }
  }

  console.log(`Privileged items scanned: ${scanned}. Needing sealing: ${toSeal}.`);
  if (apply) console.log(`Sealed: ${sealed}. Failed: ${failed}.`);
  else console.log("Dry run: nothing was changed. Run again with --apply to seal them.");
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
