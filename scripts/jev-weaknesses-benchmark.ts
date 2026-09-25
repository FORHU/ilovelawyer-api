/**
 * Gate for USE_JEV_WEAKNESSES (src/utils/weakness-jev.ts) — do Jev's support / severity /
 * surfacing reads of a weakness agree with a lawyer's?
 *
 *   npx ts-node scripts/jev-weaknesses-benchmark.ts --harvest <caseId>
 *       Writes benchmarks/jev-weaknesses/harvest-<caseId>.json: that case's current weaknesses
 *       with the exact case data Jev sees, and an empty `expected` for a lawyer to fill in.
 *       Database only — no Jev call.
 *
 *   npx ts-node scripts/jev-weaknesses-benchmark.ts [--cases benchmarks/jev-weaknesses/cases.json]
 *       Scores every labelled case and writes benchmarks/jev-weaknesses/<timestamp>.md.
 *       Needs TYPESAFE_API_KEY; no database.
 *
 * `expected.severity` and `expected.surfacing` are the level index (0..3) in SEVERITY_LEVELS /
 * SURFACING_LEVELS. Labels must come from a lawyer reading the case. Proposed ship gate (confirm
 * with the team): no false CONTRADICTED (telling a lawyer a real weakness is contradicted is the
 * costly error), MATERIAL/MINOR accuracy >= 0.8, and severity and surfacing within one level on
 * >= 0.8 of cases.
 */
import * as dotenv from "dotenv";
dotenv.config();
import * as fs from "fs";
import * as path from "path";
import {
  checkWeaknessWithJev,
  tagFromCheck,
  SupportVerdict,
  WeaknessJevInput,
  SEVERITY_LEVELS,
  SURFACING_LEVELS,
  SUPPORT_VERDICTS,
} from "../src/utils/weakness-jev";
import type { CaseJevContext } from "../src/utils/case-jev-context";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const BENCH_DIR = path.resolve(__dirname, "..", "benchmarks", "jev-weaknesses");

interface BenchCase {
  id: string;
  provenance: string;
  labelledBy: string | null;
  weakness: WeaknessJevInput;
  context: CaseJevContext;
  expected: { support: SupportVerdict; severity: number; surfacing: number } | null;
}

async function harvest(caseId: string) {
  const prisma = (await import("../src/lib/prisma")).default;
  const CaseFindingRepo = (await import("../src/repositories/case-finding.repository")).default;
  const FindingJevSvc = (await import("../src/services/finding-jev.service")).default;
  const findings = await CaseFindingRepo.list(caseId);
  const weaknesses = findings.filter((f) => f.category === "WEAKNESS");
  const cases: BenchCase[] = [];
  for (const [i, f] of weaknesses.entries()) {
    cases.push({
      id: `${caseId.slice(0, 8)}-${i + 1}`,
      provenance: `Weakness ${f.id} on case ${caseId}, harvested ${new Date().toISOString().slice(0, 10)}`,
      labelledBy: null,
      weakness: { label: f.label, detail: f.detail, sourceLabel: f.sourceLabel },
      // Judged against every other finding, the same as an on-demand check.
      context: await FindingJevSvc.loadContext(caseId, findings.filter((o) => o.id !== f.id)),
      expected: null,
    });
  }
  fs.mkdirSync(BENCH_DIR, { recursive: true });
  const out = path.join(BENCH_DIR, `harvest-${caseId}.json`);
  fs.writeFileSync(out, JSON.stringify(cases, null, 2));
  console.log(
    `Wrote ${cases.length} weaknesses to ${out}. Label each "expected" as ` +
      `{ support: ${SUPPORT_VERDICTS.join("|")}, severity: 0-${SEVERITY_LEVELS.length - 1}, surfacing: 0-${SURFACING_LEVELS.length - 1} }.`,
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
    `# Jev weaknesses benchmark — ${new Date().toISOString()}`,
    ``,
    `${cases.length} labelled of ${all.length} cases in \`${path.relative(process.cwd(), casesPath)}\`.`,
    ``,
    `| Case | Support (exp / Jev) | Tag (exp / Jev) | Severity (exp / Jev) | Surfacing (exp / Jev) |`,
    `| --- | --- | --- | --- | --- |`,
  ];
  const hits = { tag: 0, severity: 0, surfacing: 0 };
  let falseContradicted = 0;
  let errors = 0;
  const misses: string[] = [];
  const mark = (ok: boolean) => (ok ? "✓" : "✗");
  const sevTop = SEVERITY_LEVELS.length - 1;
  const surTop = SURFACING_LEVELS.length - 1;
  for (const c of cases) {
    const exp = c.expected!;
    try {
      const r = await checkWeaknessWithJev(c.weakness, c.context);
      const expTag = tagFromCheck({ support: exp.support, severity: exp.severity / sevTop });
      const jevTag = tagFromCheck(r);
      const jevSeverity = Math.round(r.severity * sevTop);
      const jevSurfacing = Math.round(r.surfacing * surTop);
      const ok = {
        tag: expTag === jevTag,
        severity: Math.abs(jevSeverity - exp.severity) <= 1,
        surfacing: Math.abs(jevSurfacing - exp.surfacing) <= 1,
      };
      (Object.keys(ok) as (keyof typeof ok)[]).forEach((k) => {
        if (ok[k]) hits[k] += 1;
      });
      if (r.support === "CONTRADICTED" && exp.support !== "CONTRADICTED") falseContradicted += 1;
      if (!ok.tag || !ok.severity || !ok.surfacing) {
        misses.push(
          `**${c.id}** "${c.weakness.label}" — expected ${exp.support} ${expTag} sev ${exp.severity} surf ${exp.surfacing}, ` +
            `Jev ${r.support} (${Math.round(r.supportConfidence * 100)}%) ${jevTag} sev ${jevSeverity} surf ${jevSurfacing}`,
        );
      }
      md.push(
        `| ${c.id} | ${exp.support} / ${r.support} | ${expTag} / ${jevTag} ${mark(ok.tag)} | ${exp.severity} / ${jevSeverity} ${mark(ok.severity)} | ${exp.surfacing} / ${jevSurfacing} ${mark(ok.surfacing)} |`,
      );
    } catch (err) {
      errors += 1;
      md.push(`| ${c.id} | error: ${(err as Error).message} | | | |`);
    }
  }
  const pct = (n: number) => (cases.length ? `${Math.round((n / cases.length) * 100)}% (${n}/${cases.length})` : "n/a");
  const atLeast = (n: number, bar: number) => cases.length > 0 && n / cases.length >= bar;
  md.push(
    ``,
    `## Summary`,
    ``,
    `- MATERIAL/MINOR accuracy: ${pct(hits.tag)}`,
    `- Severity within one level: ${pct(hits.severity)}`,
    `- Surfacing within one level: ${pct(hits.surfacing)}`,
    `- False CONTRADICTED: ${falseContradicted}`,
    `- Jev errors: ${errors}`,
    ``,
    `## Proposed ship gate`,
    ``,
    `- ${falseContradicted === 0 ? "PASS" : "FAIL"} — no false CONTRADICTED`,
    `- ${atLeast(hits.tag, 0.8) ? "PASS" : "FAIL"} — MATERIAL/MINOR accuracy ≥ 80%`,
    `- ${atLeast(hits.severity, 0.8) ? "PASS" : "FAIL"} — severity within one level ≥ 80%`,
    `- ${atLeast(hits.surfacing, 0.8) ? "PASS" : "FAIL"} — surfacing within one level ≥ 80%`,
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
