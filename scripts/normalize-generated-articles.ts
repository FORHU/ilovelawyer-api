/**
 * One-time script: normalize letter-spaced text (e.g. "D E C I S I O N" -> "DECISION")
 * in existing legalSourceAnalysisCache rows (see docs/adr/0003 in ilovelawyer-app for why
 * this regex ships unvalidated against production data).
 *
 * Dry run by default — prints a before/after diff per row that would change, writes nothing.
 * Pass --write to persist the changes.
 *
 * Run: npx ts-node scripts/normalize-generated-articles.ts [--write]
 */
import * as dotenv from "dotenv";
dotenv.config();

import prisma from "../src/lib/prisma";
import { normalizeLetterSpacing } from "../src/utils/legalSourceCache.utils";

const WRITE = process.argv.includes("--write");

async function main() {
  const rows = await prisma.legalSourceAnalysisCache.findMany({
    select: { id: true, title: true, markdownContent: true },
    orderBy: { createdAt: "asc" },
  });

  console.log(`Scanning ${rows.length} rows. Mode: ${WRITE ? "WRITE" : "DRY RUN"}\n`);

  let changed = 0;
  let unchanged = 0;

  for (const row of rows) {
    const normalized = normalizeLetterSpacing(row.markdownContent);
    if (normalized === row.markdownContent) {
      unchanged++;
      continue;
    }

    changed++;
    console.log(`--- ${row.id} :: ${row.title} ---`);
    console.log(`  before: ${row.markdownContent.slice(0, 200).replace(/\n/g, "\\n")}`);
    console.log(`  after:  ${normalized.slice(0, 200).replace(/\n/g, "\\n")}`);
    console.log("");

    if (WRITE) {
      await prisma.legalSourceAnalysisCache.update({
        where: { id: row.id },
        data: { markdownContent: normalized },
      });
    }
  }

  console.log(`Done. changed=${changed} unchanged=${unchanged} mode=${WRITE ? "WRITE" : "DRY RUN"}`);
  if (!WRITE && changed > 0) {
    console.log(`\nRe-run with --write to persist these ${changed} change(s).`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
