/**
 * Gate for USE_JEV_LEGAL_ISSUES (src/utils/legal-issue-jev.ts) — do Jev's raised / contested /
 * burden reads of a legal issue agree with a lawyer's?
 *
 *   npx ts-node scripts/jev-legal-issues-benchmark.ts --harvest <caseId>
 *       Writes benchmarks/jev-legal-issues/harvest-<caseId>.json: that case's current legal
 *       issues with the exact case data Jev sees, and an empty `expected` for a lawyer to fill
 *       in. Database only — no Jev call.
 *
 *   npx ts-node scripts/jev-legal-issues-benchmark.ts [--cases benchmarks/jev-legal-issues/cases.json]
 *       Scores every labelled case and writes benchmarks/jev-legal-issues/<timestamp>.md.
 *       Needs TYPESAFE_API_KEY; no database.
 *
 * Labels must come from a lawyer reading the case. Proposed ship gate (confirm with the team):
 * no false NOT_RAISED (telling a lawyer a real issue isn't in their case is the costly error),
 * contested accuracy >= 0.8, and burden accuracy >= 0.8.
 */
import * as dotenv from "dotenv";
dotenv.config();
import * as fs from "fs";
import * as path from "path";
import {
  checkLegalIssueWithJev,
  BurdenParty,
  ContestedVerdict,
  LegalIssueJevInput,
  RaisedVerdict,
  BURDEN_PARTIES,
  CONTESTED_VERDICTS,
  RAISED_VERDICTS,
} from "../src/utils/legal-issue-jev";
import type { CaseJevContext } from "../src/utils/case-jev-context";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const BENCH_DIR = path.resolve(__dirname, "..", "benchmarks", "jev-legal-issues");

interface BenchCase {
  id: string;
  provenance: string;
  labelledBy: string | null;
  issue: LegalIssueJevInput;
  context: CaseJevContext;
  expected: { raised: RaisedVerdict; contested: ContestedVerdict; burden: BurdenParty } | null;
}

async function harvest(caseId: string) {
  const prisma = (await import("../src/lib/prisma")).default;
  const CaseFindingRepo = (await import("../src/repositories/case-finding.repository")).default;
  const FindingJevSvc = (await import("../src/services/finding-jev.service")).default;
  const findings = await CaseFindingRepo.list(caseId);
  const issues = findings.filter((f) => f.category === "LEGAL_ISSUE");
  const cases: BenchCase[] = [];
  for (const [i, f] of issues.entries()) {
    const previous = f.jev as { modelBurden?: BurdenParty | null } | null;
    cases.push({
      id: `${caseId.slice(0, 8)}-${i + 1}`,
      provenance: `Legal issue ${f.id} on case ${caseId}, harvested ${new Date().toISOString().slice(0, 10)}`,
      labelledBy: null,
      issue: { label: f.label, detail: f.detail, sourceLabel: f.sourceLabel, modelBurden: previous?.modelBurden ?? null },
      // Judged against every other finding, the same as an on-demand check.
      context: await FindingJevSvc.loadContext(caseId, findings.filter((o) => o.id !== f.id)),
      expected: null,
    });
  }
  fs.mkdirSync(BENCH_DIR, { recursive: true });
  const out = path.join(BENCH_DIR, `harvest-${caseId}.json`);
  fs.writeFileSync(out, JSON.stringify(cases, null, 2));
  console.log(
    `Wrote ${cases.length} legal issues to ${out}. Label each "expected" as ` +
      `{ raised: ${RAISED_VERDICTS.join("|")}, contested: ${CONTESTED_VERDICTS.join("|")}, burden: ${BURDEN_PARTIES.join("|")} }.`,
  );
  await prisma.$disconnect();
}

async function score(casesPath: string) {
  if (!fs.existsSync(casesPath)) {
    console.error(`No cases at ${casesPath}. Harvest with --harvest <caseId>, have a lawyer fill in "expected", then merge into that file.`);
    process.exit(1);
  }
  if (!process.env.TYPESAFE_API_KEY) {
    console.error("TYPESAFE_API_KEY is not set.");
    process.exit(1);
  }
  const all = JSON.parse(fs.readFileSync(casesPath, "utf8")) as BenchCase[];
  const cases = all.filter((c) => c.expected);
  const md = [
    `# Jev legal issues benchmark — ${new Date().toISOString()}`,
    ``,
    `${cases.length} labelled of ${all.length} cases in \`${path.relative(process.cwd(), casesPath)}\`.`,
    ``,
    `| Case | Raised (exp / Jev) | Contested (exp / Jev) | Burden (exp / Jev) |`,
    `| --- | --- | --- | --- |`,
  ];
  const hits = { raised: 0, contested: 0, burden: 0 };
  let falseNotRaised = 0;
  let errors = 0;
  const misses: string[] = [];
  const mark = (ok: boolean) => (ok ? "✓" : "✗");
  for (const c of cases) {
    const exp = c.expected!;
    try {
      const r = await checkLegalIssueWithJev(c.issue, c.context);
      const ok = { raised: r.raised === exp.raised, contested: r.contested === exp.contested, burden: r.burden === exp.burden };
      (Object.keys(ok) as (keyof typeof ok)[]).forEach((k) => {
        if (ok[k]) hits[k] += 1;
      });
      if (r.raised === "NOT_RAISED" && exp.raised !== "NOT_RAISED") falseNotRaised += 1;
      if (!ok.raised || !ok.contested || !ok.burden) {
        misses.push(
          `**${c.id}** "${c.issue.label}" — expected ${exp.raised}/${exp.contested}/${exp.burden}, ` +
            `Jev ${r.raised} (${Math.round(r.raisedConfidence * 100)}%) / ${r.contested} (${Math.round(r.contestedConfidence * 100)}%) / ${r.burden} (${Math.round(r.burdenConfidence * 100)}%)`,
        );
      }
      md.push(
        `| ${c.id} | ${exp.raised} / ${r.raised} ${mark(ok.raised)} | ${exp.contested} / ${r.contested} ${mark(ok.contested)} | ${exp.burden} / ${r.burden} ${mark(ok.burden)} |`,
      );
    } catch (err) {
      errors += 1;
      md.push(`| ${c.id} | error: ${(err as Error).message} | | |`);
    }
  }
  const pct = (n: number) => (cases.length ? `${Math.round((n / cases.length) * 100)}% (${n}/${cases.length})` : "n/a");
  const atLeast = (n: number, bar: number) => cases.length > 0 && n / cases.length >= bar;
  md.push(
    ``,
    `## Summary`,
    ``,
    `- Raised accuracy: ${pct(hits.raised)}`,
    `- Contested accuracy: ${pct(hits.contested)}`,
    `- Burden accuracy: ${pct(hits.burden)}`,
    `- False NOT_RAISED: ${falseNotRaised}`,
    `- Jev errors: ${errors}`,
    ``,
    `## Proposed ship gate`,
    ``,
    `- ${falseNotRaised === 0 ? "PASS" : "FAIL"} — no false NOT_RAISED`,
    `- ${atLeast(hits.contested, 0.8) ? "PASS" : "FAIL"} — contested accuracy ≥ 80%`,
    `- ${atLeast(hits.burden, 0.8) ? "PASS" : "FAIL"} — burden accuracy ≥ 80%`,
    ...(misses.length ? [``, `## Misses`, ``, ...misses.map((m) => `- ${m}`)] : []),
    ``,
  );
  fs.mkdirSync(BENCH_DIR, { recursive: true });
  const outFile = path.join(BENCH_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  fs.writeFileSync(outFile, md.join("\n"));
  console.log(md.join("\n"));
  console.log(`\nWrote ${outFile}`);
}

async function main() {
  const caseId = arg("harvest");
  if (caseId) return harvest(caseId);
  return score(arg("cases") ?? path.join(BENCH_DIR, "cases.json"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
