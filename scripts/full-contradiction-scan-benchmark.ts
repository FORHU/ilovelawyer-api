/**
 * Gate for USE_FULL_CONTRADICTION_SCAN (src/services/full-contradiction-scan.service.ts) — on a
 * case holding the Brackenmoor D01–D20 bundle, does the full scan find the contradictions the
 * examiner planted (benchmarks/brackenmoor/planted-contradictions.json, from rubric criterion B)?
 *
 *   npx ts-node scripts/full-contradiction-scan-benchmark.ts --case <caseId>
 *       Dry run: facts, candidates and which planted exhibit pairs the candidates cover.
 *       Database only (read-only) — no Jev call, nothing written.
 *
 *   npx ts-node scripts/full-contradiction-scan-benchmark.ts --case <caseId> --jev
 *       Also asks Jev about every candidate (fresh — the FactPairCheck cache is neither read nor
 *       written) and reports recall on the accepted contradictions plus every verdict, so a
 *       lawyer can mark false alarms. Needs TYPESAFE_API_KEY. Writes
 *       benchmarks/full-contradiction-scan/<timestamp>.md.
 *
 * None of the four planted items the rubric names is a plain date/amount mismatch (B1 needs date
 * arithmetic — "eleven days after" vs two dates; B2-B4 are wording/record conflicts), so recall on
 * them measures what this scan does NOT yet cover. The gate that fits what it does cover:
 * a lawyer marks every accepted row real or false alarm, and every NOT_A_CONFLICT the lawyer
 * disagrees with — proposed: no false alarms among accepted rows, confirm with the team.
 */
import * as dotenv from "dotenv";
dotenv.config();
import * as fs from "fs";
import * as path from "path";
import prisma from "../src/lib/prisma";
import CaseAccess from "../src/utils/case-access";
import FullContradictionScanSvc, { FullScanVerdict, MIN_ACCEPT_CONFIDENCE } from "../src/services/full-contradiction-scan.service";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface Planted {
  id: string;
  exhibits: string[];
  what: string;
}

const PLANTED_FILE = path.resolve(__dirname, "..", "benchmarks", "brackenmoor", "planted-contradictions.json");
const OUT_DIR = path.resolve(__dirname, "..", "benchmarks", "full-contradiction-scan");

function covers(p: Planted, v: FullScanVerdict): boolean {
  const a = v.candidate.left.exhibit;
  const b = v.candidate.right.exhibit;
  if (!a || !b) return false;
  if (p.exhibits.length === 1) return a === p.exhibits[0] && b === p.exhibits[0];
  return p.exhibits.includes(a) && p.exhibits.includes(b) && a !== b;
}

const cell = (s: string) => s.replace(/\|/g, "/").replace(/\s+/g, " ").slice(0, 110);

async function main() {
  const caseId = arg("case");
  if (!caseId) {
    console.error("Usage: --case <caseId> [--jev]");
    process.exit(1);
  }
  const withJev = process.argv.includes("--jev");
  if (withJev && !process.env.TYPESAFE_API_KEY) {
    console.error("--jev needs TYPESAFE_API_KEY.");
    process.exit(1);
  }
  const planted = (JSON.parse(fs.readFileSync(PLANTED_FILE, "utf8")) as { planted: Planted[] }).planted;
  const docs = await prisma.document.findMany({ where: { caseId, ragStatus: "READY" }, select: { id: true, name: true } });
  const tenantCode = await CaseAccess.resolveTenantCode(caseId);

  const { verdicts, stats } = await FullContradictionScanSvc.scan(caseId, docs, tenantCode, { jev: withJev, cache: false });

  const md: string[] = [
    `# Full contradiction scan benchmark — ${new Date().toISOString()}`,
    ``,
    `Case \`${caseId}\` (${tenantCode}), ${withJev ? "with Jev" : "dry run, no Jev"}.`,
    ``,
    `- Documents: ${stats.documents}, chunks: ${stats.chunks}, facts: ${stats.facts}`,
    `- Candidates: ${stats.candidates}${withJev ? `, Jev-checked: ${stats.jevChecked}, accepted (DIRECT/INFERENTIAL ≥ ${MIN_ACCEPT_CONFIDENCE}): ${stats.accepted}` : ""}`,
    ``,
    `## Planted contradictions (rubric criterion B)`,
    ``,
    `| Planted | What | In candidates | ${withJev ? "Accepted |" : ""}`,
    `| --- | --- | --- | ${withJev ? "--- |" : ""}`,
  ];
  for (const p of planted) {
    const inCandidates = verdicts.filter((v) => covers(p, v)).length;
    const accepted = verdicts.filter((v) => covers(p, v) && v.accepted).length;
    md.push(`| ${p.id} | ${cell(p.what)} | ${inCandidates} | ${withJev ? `${accepted} |` : ""}`);
  }

  md.push(
    ``,
    `## Every candidate`,
    ``,
    `Lawyer review: mark each accepted row as a real contradiction or a false alarm.`,
    ``,
    `| # | Score | Left | Right | ${withJev ? "Jev | Accepted |" : ""}`,
    `| --- | --- | --- | --- | ${withJev ? "--- | --- |" : ""}`,
  );
  verdicts.forEach((v, i) => {
    const { left, right, score } = v.candidate;
    const jev = withJev ? `${v.nature ?? "error"}${v.confidence !== null ? ` ${Math.round(v.confidence * 100)}%` : ""} | ${v.accepted ? "✓" : ""} |` : "";
    md.push(
      `| ${i + 1} | ${score.toFixed(2)} | ${left.locator ?? "?"} **${left.display}** — ${cell(left.sentence)} | ${right.locator ?? "?"} **${right.display}** — ${cell(right.sentence)} | ${jev}`,
    );
  });
  md.push(``);

  const out = md.join("\n");
  console.log(out);
  if (withJev) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
    fs.writeFileSync(file, out);
    console.log(`\nWrote ${file}`);
  }
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
