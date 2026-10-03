/**
 * One-time script: split Party rows that the old partyInvolved parser merged into one
 * ("A (Petitioner / Plaintiff); B (Respondent / Defendant); C" carrying C's designation) back
 * into one row per party. Dry run by default; pass --apply to write.
 * Run: npx ts-node scripts/split-merged-parties.ts [--apply]
 */
import * as dotenv from "dotenv";
dotenv.config();

import prisma from "../src/lib/prisma";
import { normalizeCaseBody } from "../src/utils/case.utils";

const APPLY = process.argv.includes("--apply");

async function main() {
  const merged = await prisma.party.findMany({
    where: { name: { contains: ";" } },
    select: { id: true, caseId: true, name: true, designation: true, descriptor: true },
  });
  console.log(`Found ${merged.length} merged party rows.${APPLY ? "" : " (dry run — pass --apply to write)"}`);

  for (const row of merged) {
    // The last entry lost its "(Designation)" to the regex, which stored it on the row instead.
    const { parties = [] } = normalizeCaseBody({ partyInvolved: `${row.name} (${row.designation})` });
    console.log(`case ${row.caseId}: "${row.name}" → ${parties.map((p) => `${p.name} [${p.designation}]`).join(", ")}`);
    if (!APPLY || parties.length < 2) continue;

    await prisma.$transaction([
      prisma.party.delete({ where: { id: row.id } }),
      prisma.party.createMany({
        data: parties.map((p, i) => ({ ...p, caseId: row.caseId, descriptor: i === 0 ? row.descriptor : null })),
      }),
    ]);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
