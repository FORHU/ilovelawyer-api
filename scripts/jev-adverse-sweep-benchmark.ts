/**
 * Gate for USE_JEV_ADVERSE_SWEEP (src/utils/adverse-citation-jev.ts) — does Jev's read of a later
 * decision's treatment of a cited authority agree with a lawyer's?
 *
 *   npx ts-node scripts/jev-adverse-sweep-benchmark.ts --harvest <caseId>
 *       Writes benchmarks/jev-adverse-sweep/harvest-<caseId>.json: that case's current
 *       negative-treatment hits (run the sweep first) with the exact input Jev sees, and an empty
 *       `expected` for a lawyer to fill in. Database only — no Jev call.
 *
 *   npx ts-node scripts/jev-adverse-sweep-benchmark.ts [--cases benchmarks/jev-adverse-sweep/cases.json]
 *       Scores every labelled case and writes benchmarks/jev-adverse-sweep/<timestamp>.md.
 *       Needs TYPESAFE_API_KEY; no database.
 *
 * Labels must come from a lawyer reading both decisions. Proposed ship gate (confirm with the
 * team): no false NOT_ADVERSE (a real problem Jev talks away is never suggested), and accuracy
 * >= 0.8.
 */
import * as dotenv from "dotenv";
dotenv.config();
import * as fs from "fs";
import * as path from "path";
import { checkAdverseCitationWithJev, AdverseCitationJevInput, EffectVerdict, EFFECT_VERDICTS } from "../src/utils/adverse-citation-jev";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const BENCH_DIR = path.resolve(__dirname, "..", "benchmarks", "jev-adverse-sweep");

interface BenchCase {
  id: string;
  provenance: string;
  labelledBy: string | null;
  input: AdverseCitationJevInput;
  expected: EffectVerdict | null;
}

async function harvest(caseId: string) {
  const prisma = (await import("../src/lib/prisma")).default;
  const AdverseCitationHitRepo = (await import("../src/repositories/adverse-citation-hit.repository")).default;
  const CitationCheckRepo = (await import("../src/repositories/citation-check.repository")).default;
  const [hits, checks] = await Promise.all([AdverseCitationHitRepo.list(caseId), CitationCheckRepo.list(caseId)]);
  const checkById = new Map(checks.map((c) => [c.id, c]));
  const cases: BenchCase[] = hits
    .filter((h) => h.kind === "NEGATIVE_TREATMENT" && h.treatment && checkById.has(h.citationCheckId))
    .map((h, i) => {
      const check = checkById.get(h.citationCheckId)!;
      return {
        id: `${caseId.slice(0, 8)}-${i + 1}`,
        provenance: `Adverse hit ${h.id} on case ${caseId}, harvested ${new Date().toISOString().slice(0, 10)}`,
        labelledBy: null,
        input: {
          authority: { reference: check.citedReference ?? "Cited authority", citedFor: check.quotedText },
          treatment: h.treatment!,
          citingDecision: h.citingTitle ?? "a later decision",
          excerpt: h.excerpt,
        },
        expected: null,
      };
    });
  fs.mkdirSync(BENCH_DIR, { recursive: true });
  const out = path.join(BENCH_DIR, `harvest-${caseId}.json`);
  fs.writeFileSync(out, JSON.stringify(cases, null, 2));
  console.log(`Wrote ${cases.length} adverse hits to ${out}. Label each "expected" as one of: ${EFFECT_VERDICTS.join(", ")}.`);
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
    `# Jev adverse sweep benchmark — ${new Date().toISOString()}`,
    ``,
    `${cases.length} labelled of ${all.length} cases in \`${path.relative(process.cwd(), casesPath)}\`.`,
    ``,
    `| Case | Authority / treatment | Expected | Jev | Confidence | ✓ |`,
    `| --- | --- | --- | --- | --- | --- |`,
  ];
  let correct = 0;
  let falseNotAdverse = 0;
  let errors = 0;
  const misses: string[] = [];
  for (const c of cases) {
    const what = `${c.input.authority.reference} — ${c.input.treatment.toLowerCase()} in ${c.input.citingDecision}`;
    try {
      const r = await checkAdverseCitationWithJev(c.input);
      const ok = r.effect === c.expected;
      if (ok) correct += 1;
      if (r.effect === "NOT_ADVERSE" && c.expected !== "NOT_ADVERSE") falseNotAdverse += 1;
      if (!ok) misses.push(`**${c.id}** ${what} — expected ${c.expected}, Jev ${r.effect} (${Math.round(r.confidence * 100)}%)`);
      md.push(`| ${c.id} | ${what} | ${c.expected} | ${r.effect} | ${Math.round(r.confidence * 100)}% | ${ok ? "✓" : "✗"} |`);
    } catch (err) {
      errors += 1;
      md.push(`| ${c.id} | ${what} | ${c.expected} | error: ${(err as Error).message} | | |`);
    }
  }
  const accuracy = cases.length ? correct / cases.length : 0;
  md.push(
    ``,
    `## Summary`,
    ``,
    `- Accuracy: ${cases.length ? `${Math.round(accuracy * 100)}% (${correct}/${cases.length})` : "n/a"}`,
    `- False NOT_ADVERSE: ${falseNotAdverse}`,
    `- Jev errors: ${errors}`,
    ``,
    `## Proposed ship gate`,
    ``,
    `- ${falseNotAdverse === 0 ? "PASS" : "FAIL"} — no false NOT_ADVERSE`,
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
