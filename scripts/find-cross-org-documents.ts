/**
 * #374 — read-only audit: documents whose own organizationId doesn't match the case or
 * consultation they're attached to. #371 closed the upload path that let this happen and #373
 * scoped every reader to stop one from being read as part of a case it doesn't belong to; this
 * finds out whether any already exist, so the team can decide on cleanup (a separate, explicitly
 * approved step — this script changes nothing).
 *
 * A case with no organization (Case.organizationId null — a legacy or creator-owned case, see
 * CaseAccess.ownedByUser) is excluded from the case-side check: there's nothing to compare
 * against, same exception #371/#373 use. Consultation.organizationId is never null, so the
 * consultation-side check is a plain inequality.
 *
 * Run: npx ts-node scripts/find-cross-org-documents.ts
 * Prints a report and writes it to reports/cross-org-documents-<timestamp>.md (gitignored, same
 * as benchmarks/ — this is a point-in-time finding, not something to commit).
 */
import * as dotenv from "dotenv";
dotenv.config();

import * as fs from "fs";
import * as path from "path";
import prisma from "../src/lib/prisma";

interface CaseMismatch {
  documentId: string;
  documentName: string;
  documentOrgId: string;
  caseId: string;
  caseName: string;
  caseOrgId: string;
}

interface ConsultationMismatch {
  documentId: string;
  documentName: string;
  documentOrgId: string;
  consultationId: string;
  consultationTitle: string | null;
  consultationOrgId: string;
}

async function findCaseMismatches(): Promise<CaseMismatch[]> {
  return prisma.$queryRaw<CaseMismatch[]>`
    SELECT
      d.id AS "documentId",
      d.name AS "documentName",
      d."organizationId" AS "documentOrgId",
      c.id AS "caseId",
      c."caseName" AS "caseName",
      c."organizationId" AS "caseOrgId"
    FROM "Document" d
    INNER JOIN "Case" c ON c.id = d."caseId"
    WHERE c."organizationId" IS NOT NULL
      AND d."organizationId" != c."organizationId"
    ORDER BY d."createdAt" DESC
  `;
}

async function findConsultationMismatches(): Promise<ConsultationMismatch[]> {
  return prisma.$queryRaw<ConsultationMismatch[]>`
    SELECT
      d.id AS "documentId",
      d.name AS "documentName",
      d."organizationId" AS "documentOrgId",
      co.id AS "consultationId",
      co.title AS "consultationTitle",
      co."organizationId" AS "consultationOrgId"
    FROM "Document" d
    INNER JOIN "Consultation" co ON co.id = d."consultationId"
    WHERE d."organizationId" != co."organizationId"
    ORDER BY d."createdAt" DESC
  `;
}

function reportSection<T extends object>(title: string, rows: T[]): string {
  if (rows.length === 0) return `## ${title}\n\nNone found.\n`;
  const columns = Object.keys(rows[0]) as (keyof T)[];
  const header = `| ${columns.join(" | ")} |`;
  const divider = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${columns.map((c) => String(row[c] ?? "")).join(" | ")} |`).join("\n");
  return `## ${title}\n\n${rows.length} found.\n\n${header}\n${divider}\n${body}\n`;
}

async function main() {
  console.log("#374 — scanning for documents whose organizationId doesn't match their case/consultation...");
  console.log(`Database: ${(process.env.DATABASE_URL ?? "").replace(/:\/\/[^@]*@/, "://<redacted>@")}`);

  const [caseMismatches, consultationMismatches] = await Promise.all([
    findCaseMismatches(),
    findConsultationMismatches(),
  ]);

  const report = [
    `# Cross-organization document audit (#374)`,
    ``,
    `Run: ${new Date().toISOString()}`,
    ``,
    reportSection("Documents attached to a case in another organization", caseMismatches),
    reportSection("Documents attached to a consultation in another organization", consultationMismatches),
  ].join("\n");

  console.log(`\nCase mismatches: ${caseMismatches.length}`);
  console.log(`Consultation mismatches: ${consultationMismatches.length}`);

  const outDir = path.resolve(__dirname, "..", "reports");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `cross-org-documents-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  fs.writeFileSync(outFile, report);
  console.log(`\nWritten to ${outFile}`);

  await prisma.$disconnect();
  // Nothing was changed — every query above is a SELECT. Any cleanup is a separate, explicitly
  // approved step; this script doesn't do it and doesn't recommend one on its own.
  process.exit(caseMismatches.length + consultationMismatches.length > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(2);
});
