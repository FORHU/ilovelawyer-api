/**
 * Gate for USE_JEV_STRENGTHS (src/utils/strength-jev.ts) — do Jev's support / weight / rebuttal
 * reads of a strength agree with a lawyer's?
 *
 *   npx ts-node scripts/jev-strengths-benchmark.ts --harvest <caseId>
 *       Writes benchmarks/jev-strengths/harvest-<caseId>.json: that case's current strengths with
 *       the exact cited-document passages and case data Jev sees, and an empty `expected` for a
 *       lawyer to fill in. Database (and the embedding API, for the passages) — no Jev call.
 *
 *   npx ts-node scripts/jev-strengths-benchmark.ts [--cases benchmarks/jev-strengths/cases.json]
 *       Scores every labelled case and writes benchmarks/jev-strengths/<timestamp>.md.
 *       Needs TYPESAFE_API_KEY; no database.
 *
 * `expected.weight` is the level index (0..3) in WEIGHT_LEVELS. Labels must come from a lawyer
 * reading the cited document. Proposed ship gate (confirm with the team): no false CONTRADICTED
 * and no false ALREADY_REBUTTED (both talk a lawyer out of a real strength), support accuracy
 * >= 0.8, STRONG/MODERATE accuracy >= 0.8, and weight within one level on >= 0.8 of cases.
 */
import * as dotenv from "dotenv";
dotenv.config();
import * as fs from "fs";
import * as path from "path";
import {
  checkStrengthWithJev,
  tagFromCheck,
  RebuttalVerdict,
  StrengthJevInput,
  SupportVerdict,
  REBUTTAL_VERDICTS,
  SUPPORT_VERDICTS,
  WEIGHT_LEVELS,
} from "../src/utils/strength-jev";
import type { CaseJevContext } from "../src/utils/case-jev-context";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const BENCH_DIR = path.resolve(__dirname, "..", "benchmarks", "jev-strengths");

interface BenchCase {
  id: string;
  provenance: string;
  labelledBy: string | null;
  strength: StrengthJevInput;
  context: CaseJevContext;
  expected: { support: SupportVerdict; weight: number; rebuttal: RebuttalVerdict } | null;
}

async function harvest(caseId: string) {
  const prisma = (await import("../src/lib/prisma")).default;
  const CaseFindingRepo = (await import("../src/repositories/case-finding.repository")).default;
  const FindingJevSvc = (await import("../src/services/finding-jev.service")).default;
  const findings = await CaseFindingRepo.list(caseId);
  const strengths = findings.filter((f) => f.category === "STRENGTH");
  const cases: BenchCase[] = [];
  for (const [i, f] of strengths.entries()) {
    cases.push({
      id: `${caseId.slice(0, 8)}-${i + 1}`,
      provenance: `Strength ${f.id} on case ${caseId}, harvested ${new Date().toISOString().slice(0, 10)}`,
      labelledBy: null,
      strength: {
        label: f.label,
        detail: f.detail,
        sourceLabel: f.sourceLabel,
        passages: await FindingJevSvc.sourcePassages(caseId, f.label, f.sourceLabel),
      },
      // Judged against every other finding, the same as an on-demand check.
      context: await FindingJevSvc.loadContext(caseId, findings.filter((o) => o.id !== f.id)),
      expected: null,
    });
  }
  fs.mkdirSync(BENCH_DIR, { recursive: true });
  const out = path.join(BENCH_DIR, `harvest-${caseId}.json`);
  fs.writeFileSync(out, JSON.stringify(cases, null, 2));
  console.log(
    `Wrote ${cases.length} strengths to ${out}. Label each "expected" as ` +
      `{ support: ${SUPPORT_VERDICTS.join("|")}, weight: 0-${WEIGHT_LEVELS.length - 1}, rebuttal: ${REBUTTAL_VERDICTS.join("|")} }.`,
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
    `# Jev strengths benchmark — ${new Date().toISOString()}`,
    ``,
    `${cases.length} labelled of ${all.length} cases in \`${path.relative(process.cwd(), casesPath)}\`.`,
    ``,
    `| Case | Source read | Support (exp / Jev) | Tag (exp / Jev) | Weight (exp / Jev) | Rebuttal (exp / Jev) |`,
    `| --- | --- | --- | --- | --- | --- |`,
  ];
  const hits = { support: 0, tag: 0, weight: 0 };
  let falseContradicted = 0;
  let falseRebutted = 0;
  let errors = 0;
  const misses: string[] = [];
  const mark = (ok: boolean) => (ok ? "✓" : "✗");
  const top = WEIGHT_LEVELS.length - 1;
  for (const c of cases) {
    const exp = c.expected!;
    try {
      const r = await checkStrengthWithJev(c.strength, c.context);
      const expTag = tagFromCheck({ support: exp.support, weight: exp.weight / top, rebuttal: exp.rebuttal });
      const jevTag = tagFromCheck(r);
      const jevWeight = Math.round(r.weight * top);
      const ok = { support: r.support === exp.support, tag: expTag === jevTag, weight: Math.abs(jevWeight - exp.weight) <= 1 };
      (Object.keys(ok) as (keyof typeof ok)[]).forEach((k) => {
        if (ok[k]) hits[k] += 1;
      });
      if (r.support === "CONTRADICTED" && exp.support !== "CONTRADICTED") falseContradicted += 1;
      if (r.rebuttal === "ALREADY_REBUTTED" && exp.rebuttal !== "ALREADY_REBUTTED") falseRebutted += 1;
      if (!ok.support || !ok.tag || !ok.weight) {
        misses.push(
          `**${c.id}** "${c.strength.label}" — expected ${exp.support} ${expTag} weight ${exp.weight} ${exp.rebuttal}, ` +
            `Jev ${r.support} (${Math.round(r.supportConfidence * 100)}%) ${jevTag} weight ${jevWeight} ${r.rebuttal}` +
            (r.sourceRead ? "" : " (no source text)"),
        );
      }
      md.push(
        `| ${c.id} | ${r.sourceRead ? "yes" : "no"} | ${exp.support} / ${r.support} ${mark(ok.support)} | ${expTag} / ${jevTag} ${mark(ok.tag)} | ${exp.weight} / ${jevWeight} ${mark(ok.weight)} | ${exp.rebuttal} / ${r.rebuttal} |`,
      );
    } catch (err) {
      errors += 1;
      md.push(`| ${c.id} | | error: ${(err as Error).message} | | | |`);
    }
  }
  const pct = (n: number) => (cases.length ? `${Math.round((n / cases.length) * 100)}% (${n}/${cases.length})` : "n/a");
  const atLeast = (n: number, bar: number) => cases.length > 0 && n / cases.length >= bar;
  md.push(
    ``,
    `## Summary`,
    ``,
    `- Support accuracy: ${pct(hits.support)}`,
    `- STRONG/MODERATE accuracy: ${pct(hits.tag)}`,
    `- Weight within one level: ${pct(hits.weight)}`,
    `- False CONTRADICTED: ${falseContradicted}`,
    `- False ALREADY_REBUTTED: ${falseRebutted}`,
    `- Jev errors: ${errors}`,
    ``,
    `## Proposed ship gate`,
    ``,
    `- ${falseContradicted === 0 ? "PASS" : "FAIL"} — no false CONTRADICTED`,
    `- ${falseRebutted === 0 ? "PASS" : "FAIL"} — no false ALREADY_REBUTTED`,
    `- ${atLeast(hits.support, 0.8) ? "PASS" : "FAIL"} — support accuracy ≥ 80%`,
    `- ${atLeast(hits.tag, 0.8) ? "PASS" : "FAIL"} — STRONG/MODERATE accuracy ≥ 80%`,
    `- ${atLeast(hits.weight, 0.8) ? "PASS" : "FAIL"} — weight within one level ≥ 80%`,
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
