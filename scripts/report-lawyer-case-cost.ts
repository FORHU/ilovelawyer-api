/**
 * Staff only. How much AI each lawyer's cases have cost, per case, from the usage records
 * (LlmUsage, every provider). For understanding what a lawyer costs us; never shown to lawyers.
 *
 *   npx ts-node --files scripts/report-lawyer-case-cost.ts [--min 0]
 *
 * Prints one block per lawyer (highest total first) with their cases, each case's cost and any extra
 * allowance staff added. --min hides lawyers whose total is below that many USD. Read-only.
 */
import prisma from "../src/lib/prisma";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

async function main() {
  const min = Number(arg("min") ?? 0);
  const spend = await prisma.llmUsage.groupBy({ by: ["caseId"], where: { caseId: { not: null } }, _sum: { estimatedCostUsd: true }, _count: { _all: true } });
  const cases = await prisma.case.findMany({
    where: { id: { in: spend.map((s) => s.caseId as string) }, user: { role: "LAWYER" } },
    select: { id: true, caseName: true, extraAiAllowanceUsd: true, createdAt: true, user: { select: { id: true, email: true, name: true } } },
  });
  const byCase = new Map(spend.map((s) => [s.caseId as string, s]));
  const lawyers = new Map<string, { email: string; name: string | null; total: number; rows: string[] }>();
  for (const c of cases) {
    const s = byCase.get(c.id)!;
    const cost = s._sum.estimatedCostUsd ?? 0;
    const entry = lawyers.get(c.user!.id) ?? { email: c.user!.email, name: c.user!.name ?? null, total: 0, rows: [] };
    entry.total += cost;
    entry.rows.push(`    $${cost.toFixed(2).padStart(7)}  ${s._count._all} calls  ${c.createdAt.toISOString().slice(0, 10)}  ${c.caseName.slice(0, 60)}${c.extraAiAllowanceUsd ? `  (+$${c.extraAiAllowanceUsd} allowance added)` : ""}`);
    lawyers.set(c.user!.id, entry);
  }
  const ranked = [...lawyers.values()].filter((l) => l.total >= min).sort((a, b) => b.total - a.total);
  for (const l of ranked) {
    console.log(`${l.name ?? l.email} <${l.email}>  total $${l.total.toFixed(2)}  (${l.rows.length} cases)`);
    l.rows.forEach((r) => console.log(r));
  }
  console.log(`\n${ranked.length} lawyers, $${ranked.reduce((t, l) => t + l.total, 0).toFixed(2)} in total`);
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
