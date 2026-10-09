/**
 * Seals the text of document chunks that were stored before field encryption was turned on (#343).
 * New chunks are sealed as they are written (DocumentChunkRepo.insertMany); this covers the rest.
 *
 * Needs FIELD_ENCRYPTION_ENABLED=true and FIELD_ENCRYPTION_KEY. Safe to run again: a chunk that is
 * already sealed is skipped. Chunks are processed in small batches in id order, so it can be
 * stopped and restarted. Only the text changes; embeddings and everything else are untouched.
 *
 * Dry run (default):       npx ts-node scripts/encrypt-document-chunks.ts
 * Do it:                   npx ts-node scripts/encrypt-document-chunks.ts --apply
 * One document only:       npx ts-node scripts/encrypt-document-chunks.ts --document <documentId> [--apply]
 *
 * Redis may hold a readable copy of a document for up to 5 minutes from before the change; it
 * expires on its own. Backups taken before this run still hold the plain text until they expire.
 */
import * as dotenv from "dotenv";
dotenv.config();

import prisma from "../src/lib/prisma";
import { FIELD_ENCRYPTION_ENABLED, FIELD_ENCRYPTION_KEY } from "../src/config";
import { sealField } from "../src/utils/field-crypto";
import { CHUNK_TEXT } from "../src/repositories/document-chunk.repository";

// Kept small: a chunk can be large, and Prisma fails on very large single results.
const BATCH = 200;
const apply = process.argv.includes("--apply");
const documentFlag = process.argv.indexOf("--document");
const onlyDocument = documentFlag >= 0 ? process.argv[documentFlag + 1] : undefined;

async function main() {
  if (!FIELD_ENCRYPTION_ENABLED || !FIELD_ENCRYPTION_KEY) {
    console.error("Set FIELD_ENCRYPTION_ENABLED=true and FIELD_ENCRYPTION_KEY first; nothing was changed.");
    process.exit(1);
  }
  if (documentFlag >= 0 && !onlyDocument) {
    console.error("--document needs a document id; nothing was changed.");
    process.exit(1);
  }

  const scope = onlyDocument ? `document ${onlyDocument}` : "all documents";
  let lastId = "";
  let scanned = 0;
  let sealed = 0;

  for (;;) {
    const rows = await prisma.$queryRaw<{ id: string; chunkText: string }[]>`
      SELECT id, "chunkText"
      FROM "CaseDocumentChunk"
      WHERE id > ${lastId}
        AND "chunkText" NOT LIKE 'enc1:%'
        AND (${onlyDocument ?? null}::text IS NULL OR "caseDocumentId" = ${onlyDocument ?? null})
      ORDER BY id ASC
      LIMIT ${BATCH}
    `;
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1]!.id;
    scanned += rows.length;
    if (!apply) continue;

    const params: unknown[] = [];
    const values = rows.map((row, i) => {
      params.push(row.id, sealField(row.chunkText, CHUNK_TEXT, true));
      return `($${i * 2 + 1}::text, $${i * 2 + 2}::text)`;
    });
    // The extra NOT LIKE keeps a concurrent run from sealing the same chunk twice.
    const changed = await prisma.$executeRawUnsafe(
      `UPDATE "CaseDocumentChunk" AS c SET "chunkText" = v.t
       FROM (VALUES ${values.join(", ")}) AS v(id, t)
       WHERE c.id = v.id AND c."chunkText" NOT LIKE 'enc1:%'`,
      ...params,
    );
    sealed += changed;
    if (sealed % 5000 < BATCH) console.log(`  ...${sealed} chunks sealed`);
  }

  console.log(`Chunks in ${scope} not yet sealed: ${scanned}.`);
  if (apply) console.log(`Sealed: ${sealed}.`);
  else console.log("Dry run: nothing was changed. Run again with --apply to seal them.");
  await prisma.$disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
