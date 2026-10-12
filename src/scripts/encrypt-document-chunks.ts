/**
 * Seals the text of document chunks that were stored before field encryption was turned on
 * (#343), or puts it back to plain text with --reverse. New chunks are sealed as they are written
 * (DocumentChunkRepo.insertMany); this covers the rest.
 *
 * Seal:     needs FIELD_ENCRYPTION_ENABLED=true and FIELD_ENCRYPTION_KEY.
 * Reverse:  needs the key (FIELD_ENCRYPTION_KEY, plus FIELD_ENCRYPTION_OLD_KEYS if the chunks were
 *           sealed under an older one). Set FIELD_ENCRYPTION_ENABLED=false first, or new uploads
 *           will be sealed again straight away.
 *
 * Always safe to rerun and to stop: a chunk already in the wanted form is skipped, chunks are
 * processed in small batches in id order, only the text changes (embeddings and everything else
 * are untouched), and a chunk that cannot be opened (its key is gone) is counted and left exactly
 * as it is, never overwritten.
 *
 * It is compiled with the app, so it also runs inside the production container:
 *   Dry run (default):   node dist/scripts/encrypt-document-chunks.js
 *   Do it:               node dist/scripts/encrypt-document-chunks.js --apply
 *   Undo it:             node dist/scripts/encrypt-document-chunks.js --reverse --apply
 *   One document only:   ... --document <documentId>
 * From a checkout: npx ts-node src/scripts/encrypt-document-chunks.ts [same options]
 *
 * Redis may hold a copy of a document for up to 5 minutes from before a change; it expires on its
 * own. Backups taken before this run still hold the plain text until they expire.
 */
import * as dotenv from "dotenv";
dotenv.config();

import prisma from "../lib/prisma";
import { FIELD_ENCRYPTION_ENABLED, FIELD_ENCRYPTION_KEY, FIELD_ENCRYPTION_OLD_KEYS } from "../config";
import { openField, sealField } from "../utils/field-crypto";
import { CHUNK_TEXT } from "../repositories/document-chunk.repository";

// Kept small: a chunk can be large, and Prisma fails on very large single results.
const BATCH = 200;

export interface ChunkBackfillOptions {
  /** Without it nothing is written; the result still says what would change. */
  apply: boolean;
  /** Put sealed chunks back to plain text instead of sealing plain ones. */
  reverse?: boolean;
  /** Limit the run to one document. */
  documentId?: string;
}

export interface ChunkBackfillResult {
  /** Chunks that were in the form being changed. */
  matched: number;
  /** Chunks actually rewritten (always 0 without apply). */
  changed: number;
  /** Sealed chunks that could not be opened and were left alone (reverse only). */
  unreadable: number;
}

/** Throws, without touching anything, when the settings cannot do what was asked. */
function assertConfigured(reverse: boolean): void {
  if (reverse) {
    if (!FIELD_ENCRYPTION_KEY && !FIELD_ENCRYPTION_OLD_KEYS) throw new Error("Set FIELD_ENCRYPTION_KEY (and FIELD_ENCRYPTION_OLD_KEYS if needed) so sealed chunks can be opened; nothing was changed.");
    return;
  }
  if (!FIELD_ENCRYPTION_ENABLED || !FIELD_ENCRYPTION_KEY) throw new Error("Set FIELD_ENCRYPTION_ENABLED=true and FIELD_ENCRYPTION_KEY first; nothing was changed.");
}

export async function backfillChunks(options: ChunkBackfillOptions, log: (line: string) => void = console.log): Promise<ChunkBackfillResult> {
  const reverse = options.reverse === true;
  assertConfigured(reverse);
  if (reverse && FIELD_ENCRYPTION_ENABLED) log("Warning: FIELD_ENCRYPTION_ENABLED is still true, so new uploads will be sealed again. Turn it off for a lasting undo.");

  const documentId = options.documentId ?? null;
  let lastId = "";
  const result: ChunkBackfillResult = { matched: 0, changed: 0, unreadable: 0 };

  for (;;) {
    // Sealed or not sealed, depending on the direction. The LIKE is the whole definition of "sealed".
    const rows = reverse
      ? await prisma.$queryRaw<{ id: string; chunkText: string }[]>`
          SELECT id, "chunkText" FROM "CaseDocumentChunk"
          WHERE id > ${lastId} AND "chunkText" LIKE 'enc1:%'
            AND (${documentId}::text IS NULL OR "caseDocumentId" = ${documentId})
          ORDER BY id ASC LIMIT ${BATCH}`
      : await prisma.$queryRaw<{ id: string; chunkText: string }[]>`
          SELECT id, "chunkText" FROM "CaseDocumentChunk"
          WHERE id > ${lastId} AND "chunkText" NOT LIKE 'enc1:%'
            AND (${documentId}::text IS NULL OR "caseDocumentId" = ${documentId})
          ORDER BY id ASC LIMIT ${BATCH}`;
    if (rows.length === 0) break;
    lastId = rows[rows.length - 1]!.id;

    const updates: { id: string; text: string }[] = [];
    for (const row of rows) {
      if (reverse) {
        const plain = openField(row.chunkText, CHUNK_TEXT);
        if (plain === null) result.unreadable += 1;
        else updates.push({ id: row.id, text: plain });
      } else {
        updates.push({ id: row.id, text: sealField(row.chunkText, CHUNK_TEXT, true) });
      }
    }
    result.matched += updates.length;
    if (!options.apply || updates.length === 0) continue;

    const params: unknown[] = [];
    const values = updates.map((u, i) => {
      params.push(u.id, u.text);
      return `($${i * 2 + 1}::text, $${i * 2 + 2}::text)`;
    });
    // The extra condition keeps a concurrent run from changing the same chunk twice.
    const guard = reverse ? `c."chunkText" LIKE 'enc1:%'` : `c."chunkText" NOT LIKE 'enc1:%'`;
    const changed = await prisma.$executeRawUnsafe(
      `UPDATE "CaseDocumentChunk" AS c SET "chunkText" = v.t
       FROM (VALUES ${values.join(", ")}) AS v(id, t)
       WHERE c.id = v.id AND ${guard}`,
      ...params,
    );
    result.changed += changed;
    if (result.changed % 5000 < BATCH) log(`  ...${result.changed} chunks done`);
  }
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const documentFlag = args.indexOf("--document");
  const documentId = documentFlag >= 0 ? args[documentFlag + 1] : undefined;
  if (documentFlag >= 0 && !documentId) {
    console.error("--document needs a document id; nothing was changed.");
    process.exit(1);
  }
  const options: ChunkBackfillOptions = { apply: args.includes("--apply"), reverse: args.includes("--reverse"), documentId };
  const scope = documentId ? `document ${documentId}` : "all documents";
  const verb = options.reverse ? "sealed (to be put back to plain text)" : "not yet sealed";

  try {
    const result = await backfillChunks(options);
    console.log(`Chunks in ${scope} ${verb}: ${result.matched}.`);
    if (result.unreadable) console.log(`Could not be opened with the configured key, left untouched: ${result.unreadable}.`);
    if (options.apply) console.log(`${options.reverse ? "Unsealed" : "Sealed"}: ${result.changed}.`);
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
