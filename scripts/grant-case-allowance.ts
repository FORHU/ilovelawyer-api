/**
 * Staff only. Adds to one case's AI allowance when its lawyer has asked us for more. The standard
 * allowance is internal and is never shown to lawyers; run this on request and tell them only that
 * the case is open for more work.
 *
 *   npx ts-node --files scripts/grant-case-allowance.ts --case <case id> [--usd 20]
 *
 * --usd defaults to 20 and is added to what the case already has. Run against the environment the
 * case lives in (DATABASE_URL in .env).
 */
import prisma from "../src/lib/prisma";
import CaseLimitsSvc from "../src/services/case-limits.service";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

async function main() {
  const caseId = arg("case");
  const usd = Number(arg("usd") ?? 20);
  if (!caseId) throw new Error("--case <case id> is required");
  if (!Number.isFinite(usd) || usd <= 0) throw new Error("--usd must be a positive number");
  const before = await prisma.case.findUnique({ where: { id: caseId }, select: { caseName: true, extraAiAllowanceUsd: true, user: { select: { email: true, role: true } } } });
  if (!before) throw new Error(`No case ${caseId} in this database`);
  const updated = await CaseLimitsSvc.grantExtraAllowance(caseId, usd);
  console.log(`"${updated.caseName}" (${before.user?.email ?? "no owner"}, ${before.user?.role ?? "-"}): extra allowance ${before.extraAiAllowanceUsd} -> ${updated.extraAiAllowanceUsd}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit();
  });
