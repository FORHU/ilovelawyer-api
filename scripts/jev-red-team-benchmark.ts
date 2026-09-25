/**
 * Gate for USE_JEV_REDTEAM (src/utils/red-team-jev.ts) — do Jev's ratings of the Red Team's
 * ranked arguments agree with a lawyer's, and do they agree better than the author model's own
 * self-rating they replace?
 *
 *   npx ts-node scripts/jev-red-team-benchmark.ts --harvest <caseId> --user <userId>
 *       Writes benchmarks/jev-red-team/harvest-<caseId>.json: that case's current ranked
 *       arguments plus the exact case data Jev would see, with empty `expected` fields for a
 *       lawyer to fill in. Needs the database only — no Jev call.
 *
 *   npx ts-node scripts/jev-red-team-benchmark.ts [--cases benchmarks/jev-red-team/cases.json]
 *       Scores every labelled case (entries whose `expected` is filled in) and writes
 *       benchmarks/jev-red-team/<timestamp>.md. Needs TYPESAFE_API_KEY; no database.
 *
 * Labels must come from a lawyer reading the case, not from this code's author — the point is an
 * independent reading. Merge labelled harvest files into cases.json (a JSON array of cases).
 *
 * Proposed ship gate (confirm with the team before relying on it):
 *   - no false CONTRADICTED support verdicts (a wrong accusation is worse than a miss),
 *   - Jev strength accuracy >= 0.8 and not below the author model's own accuracy,
 *   - severity within one level of the label on >= 0.8 of cases.
 */
import * as dotenv from "dotenv";
dotenv.config();
import * as fs from "fs";
import * as path from "path";
import {
  rateArgumentWithJev,
  strengthFromLikelihood,
  impactFromRatings,
  SEVERITY_LEVELS,
  SupportVerdict,
  RedTeamJevContext,
} from "../src/utils/red-team-jev";
import type { RedTeamArgument, RedTeamArgumentStrength } from "../src/utils/red-team-arguments-parse";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const BENCH_DIR = path.resolve(__dirname, "..", "benchmarks", "jev-red-team");

interface BenchCase {
  id: string;
  /** Where the argument came from, and who labelled it. */
  provenance: string;
  labelledBy: string | null;
  context: RedTeamJevContext;
  argument: RedTeamArgument;
  expected: {
    support: SupportVerdict | null;
    strength: RedTeamArgumentStrength | null;
    /** Index into SEVERITY_LEVELS (0 = side point … 3 = disposes of the whole case). */
    severityLevel: number | null;
  };
}

async function harvest(caseId: string, userId: string) {
  const prisma = (await import("../src/lib/prisma")).default;
  const RedTeamSvc = (await import("../src/services/red-team.service")).default;
  const { jevContext } = await import("../src/services/red-team.service");
  const row = await prisma.redTeamAssessment.findUnique({ where: { caseId } });
  const stored = row?.arguments as unknown as { opponent: string | null; arguments: RedTeamArgument[] } | null;
  if (!stored?.arguments?.length) {
    console.error(`No ranked arguments stored for case ${caseId} — regenerate its Red Team first.`);
    await prisma.$disconnect();
    process.exit(1);
  }
  const context = jevContext(await RedTeamSvc.promptDataFor(caseId, userId), stored.opponent);
  const cases: BenchCase[] = stored.arguments.map((a, i) => ({
    id: `${caseId.slice(0, 8)}-${i + 1}`,
    provenance: `Red Team for case ${caseId}, harvested ${new Date().toISOString().slice(0, 10)}`,
    labelledBy: null,
    context,
    // Keep only the author model's own rating — a Jev rating already on the row would leak the answer.
    argument: {
      title: a.title,
      gist: a.gist,
      strength: (a as { modelStrength?: RedTeamArgumentStrength }).modelStrength ?? a.strength,
      impact: (a as { modelImpact?: number }).modelImpact ?? a.impact,
      reasoning: a.reasoning,
      source: a.source,
    },
    expected: { support: null, strength: null, severityLevel: null },
  }));
  fs.mkdirSync(BENCH_DIR, { recursive: true });
  const out = path.join(BENCH_DIR, `harvest-${caseId}.json`);
  fs.writeFileSync(out, JSON.stringify(cases, null, 2));
  console.log(`Wrote ${cases.length} arguments to ${out}. Severity levels for labelling:`);
  SEVERITY_LEVELS.forEach((l, i) => console.log(`  ${i}: ${l}`));
  await prisma.$disconnect();
}

async function score(casesPath: string) {
  if (!fs.existsSync(casesPath)) {
    console.error(`No cases at ${casesPath}. Harvest with --harvest <caseId> --user <userId>, have a lawyer fill in "expected", then merge into that file.`);
    process.exit(1);
  }
  if (!process.env.TYPESAFE_API_KEY) {
    console.error("TYPESAFE_API_KEY is not set.");
    process.exit(1);
  }
  const all = JSON.parse(fs.readFileSync(casesPath, "utf8")) as BenchCase[];
  const cases = all.filter((c) => c.expected.support || c.expected.strength || c.expected.severityLevel !== null);

  const md: string[] = [
    `# Jev red-team benchmark — ${new Date().toISOString()}`,
    ``,
    `${cases.length} labelled of ${all.length} cases in \`${path.relative(process.cwd(), casesPath)}\`.`,
    ``,
    `| Case | Support exp | Jev | ✓ | Strength exp | Model | Jev | ✓ | Severity exp | Jev | ±1 | Impact model→Jev | Uncertain |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
  ];
  const tally = { support: 0, supportN: 0, falseContradicted: 0, jevStrength: 0, modelStrength: 0, strengthN: 0, severity: 0, severityN: 0, errors: 0 };
  const misses: string[] = [];

  for (const c of cases) {
    try {
      const r = await rateArgumentWithJev(c.argument, c.context);
      const jevStrength = strengthFromLikelihood(r.likelihood);
      const jevSeverityLevel = Math.round(r.severity * (SEVERITY_LEVELS.length - 1));
      const impact = impactFromRatings(r.likelihood, r.severity, r.support);
      const e = c.expected;

      const supOk = e.support ? r.support === e.support : null;
      if (e.support) {
        tally.supportN += 1;
        if (supOk) tally.support += 1;
        if (r.support === "CONTRADICTED" && e.support !== "CONTRADICTED") tally.falseContradicted += 1;
      }
      const strOk = e.strength ? jevStrength === e.strength : null;
      if (e.strength) {
        tally.strengthN += 1;
        if (strOk) tally.jevStrength += 1;
        if (c.argument.strength === e.strength) tally.modelStrength += 1;
      }
      const sevOk = e.severityLevel !== null ? Math.abs(jevSeverityLevel - e.severityLevel) <= 1 : null;
      if (e.severityLevel !== null) {
        tally.severityN += 1;
        if (sevOk) tally.severity += 1;
      }
      if (supOk === false || strOk === false || sevOk === false) {
        misses.push(
          `**${c.id}** "${c.argument.title}" — support ${r.support} (${Math.round(r.supportConfidence * 100)}%), likelihood ${r.likelihood.toFixed(2)} (${Math.round(r.likelihoodConfidence * 100)}%), severity ${r.severity.toFixed(2)} (${Math.round(r.severityConfidence * 100)}%); cited ${c.argument.source.kind}: "${c.argument.source.label}"`,
        );
      }
      const mark = (ok: boolean | null) => (ok === null ? "—" : ok ? "✓" : "✗");
      md.push(
        `| ${c.id} | ${e.support ?? "—"} | ${r.support} ${Math.round(r.supportConfidence * 100)}% | ${mark(supOk)} | ${e.strength ?? "—"} | ${c.argument.strength} | ${jevStrength} | ${mark(strOk)} | ${e.severityLevel ?? "—"} | ${jevSeverityLevel} | ${mark(sevOk)} | ${c.argument.impact} → ${impact} | ${r.uncertain ? "yes" : ""} |`,
      );
    } catch (err) {
      tally.errors += 1;
      md.push(`| ${c.id} | error: ${(err as Error).message} |`);
    }
  }

  const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}% (${n}/${d})` : "n/a");
  const strengthGate = tally.strengthN > 0 && tally.jevStrength / tally.strengthN >= 0.8 && tally.jevStrength >= tally.modelStrength;
  const severityGate = tally.severityN > 0 && tally.severity / tally.severityN >= 0.8;
  md.push(
    ``,
    `## Summary`,
    ``,
    `- Support accuracy: ${pct(tally.support, tally.supportN)}`,
    `- False CONTRADICTED: ${tally.falseContradicted}`,
    `- Strength accuracy — Jev: ${pct(tally.jevStrength, tally.strengthN)}, author model: ${pct(tally.modelStrength, tally.strengthN)}`,
    `- Severity within one level: ${pct(tally.severity, tally.severityN)}`,
    `- Jev errors: ${tally.errors}`,
    ``,
    `## Proposed ship gate`,
    ``,
    `- ${tally.falseContradicted === 0 ? "PASS" : "FAIL"} — no false CONTRADICTED`,
    `- ${strengthGate ? "PASS" : "FAIL"} — Jev strength accuracy ≥ 80% and ≥ the author model's`,
    `- ${severityGate ? "PASS" : "FAIL"} — severity within one level on ≥ 80%`,
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
  const harvestCase = arg("harvest");
  if (harvestCase) {
    const user = arg("user");
    if (!user) {
      console.error("--harvest needs --user <userId> (someone with access to the case).");
      process.exit(1);
    }
    return harvest(harvestCase, user);
  }
  return score(arg("cases") ?? path.join(BENCH_DIR, "cases.json"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
