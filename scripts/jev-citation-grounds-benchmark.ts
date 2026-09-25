/**
 * Gate for USE_JEV_CITATION_GROUNDS (src/utils/citation-ground-jev.ts) — does Jev's read of an
 * authority → claim link in the Citation Map agree with a lawyer's?
 *
 *   npx ts-node scripts/jev-citation-grounds-benchmark.ts --harvest <caseId>
 *       Writes benchmarks/jev-citation-grounds/harvest-<caseId>.json: every authority × claim pair
 *       on that case (linked or not) with the exact input Jev sees, and an empty `expected` for a
 *       lawyer to fill in. Database only — no Jev call.
 *
 *   npx ts-node scripts/jev-citation-grounds-benchmark.ts [--cases benchmarks/jev-citation-grounds/cases.json]
 *       Scores every labelled case and writes benchmarks/jev-citation-grounds/<timestamp>.md.
 *       Needs TYPESAFE_API_KEY; no database.
 *
 * Every pair is harvested, not just the linked ones, so the set has real DOES_NOT_APPLY cases.
 * Labels must come from a lawyer. Proposed ship gate (confirm with the team): no false
 * DOES_NOT_APPLY (an AI link Jev wrongly drops never reaches the lawyer), and accuracy >= 0.8.
 */
import * as dotenv from "dotenv";
dotenv.config();
import * as fs from "fs";
import * as path from "path";
import {
  checkCitationGroundWithJev,
  AttachesVerdict,
  CitationGroundJevInput,
  ATTACHES_VERDICTS,
} from "../src/utils/citation-ground-jev";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const BENCH_DIR = path.resolve(__dirname, "..", "benchmarks", "jev-citation-grounds");

interface BenchCase {
  id: string;
  provenance: string;
  labelledBy: string | null;
  input: CitationGroundJevInput;
  expected: AttachesVerdict | null;
}

async function harvest(caseId: string) {
  const prisma = (await import("../src/lib/prisma")).default;
  const CaseClaimRepo = (await import("../src/repositories/case-claim.repository")).default;
  const CitationCheckRepo = (await import("../src/repositories/citation-check.repository")).default;
  const CitationGroundRepo = (await import("../src/repositories/citation-ground.repository")).default;
  const { jevInput, resolvedTitles } = await import("../src/services/citation-ground.service");
  const [claims, allChecks, grounds] = await Promise.all([
    CaseClaimRepo.list(caseId),
    CitationCheckRepo.list(caseId),
    CitationGroundRepo.list(caseId),
  ]);
  const checks = allChecks.filter((c) => c.citedReference);
  const titles = await resolvedTitles(checks);
  const roleOf = new Map(grounds.map((g) => [`${g.citationCheckId}:${g.claimId}`, g.role]));
  const cases: BenchCase[] = [];
  for (const check of checks) {
    for (const claim of claims) {
      const linkedRole = roleOf.get(`${check.id}:${claim.id}`);
      cases.push({
        id: `${caseId.slice(0, 8)}-${cases.length + 1}`,
        provenance: `${check.citedReference} → ${claim.title} on case ${caseId} (${linkedRole ? "linked" : "not linked"}), harvested ${new Date().toISOString().slice(0, 10)}`,
        labelledBy: null,
        input: jevInput(check, claim, linkedRole ?? "SUBSTANTIVE", titles),
        expected: null,
      });
    }
  }
  fs.mkdirSync(BENCH_DIR, { recursive: true });
  const out = path.join(BENCH_DIR, `harvest-${caseId}.json`);
  fs.writeFileSync(out, JSON.stringify(cases, null, 2));
  console.log(`Wrote ${cases.length} authority × claim pairs to ${out}. Label each "expected" as one of: ${ATTACHES_VERDICTS.join(", ")}.`);
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
    `# Jev citation grounds benchmark — ${new Date().toISOString()}`,
    ``,
    `${cases.length} labelled of ${all.length} cases in \`${path.relative(process.cwd(), casesPath)}\`.`,
    ``,
    `| Case | Authority → claim | Expected | Jev | Confidence | ✓ |`,
    `| --- | --- | --- | --- | --- | --- |`,
  ];
  let correct = 0;
  let falseDoesNotApply = 0;
  let errors = 0;
  const misses: string[] = [];
  for (const c of cases) {
    const pair = `${c.input.authority.reference} → ${c.input.claim.title}`;
    try {
      const r = await checkCitationGroundWithJev(c.input);
      const ok = r.attaches === c.expected;
      if (ok) correct += 1;
      if (r.attaches === "DOES_NOT_APPLY" && c.expected !== "DOES_NOT_APPLY") falseDoesNotApply += 1;
      if (!ok) misses.push(`**${c.id}** ${pair} — expected ${c.expected}, Jev ${r.attaches} (${Math.round(r.confidence * 100)}%)`);
      md.push(`| ${c.id} | ${pair} | ${c.expected} | ${r.attaches} | ${Math.round(r.confidence * 100)}% | ${ok ? "✓" : "✗"} |`);
    } catch (err) {
      errors += 1;
      md.push(`| ${c.id} | ${pair} | ${c.expected} | error: ${(err as Error).message} | | |`);
    }
  }
  const accuracy = cases.length ? correct / cases.length : 0;
  md.push(
    ``,
    `## Summary`,
    ``,
    `- Accuracy: ${cases.length ? `${Math.round(accuracy * 100)}% (${correct}/${cases.length})` : "n/a"}`,
    `- False DOES_NOT_APPLY: ${falseDoesNotApply}`,
    `- Jev errors: ${errors}`,
    ``,
    `## Proposed ship gate`,
    ``,
    `- ${falseDoesNotApply === 0 ? "PASS" : "FAIL"} — no false DOES_NOT_APPLY`,
    `- ${cases.length && accuracy >= 0.8 ? "PASS" : "FAIL"} — accuracy ≥ 80%`,
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
