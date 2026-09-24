/**
 * Gate for USE_JEV_CONTRADICTIONS (src/utils/contradiction-nature-jev.ts) — does Jev's
 * DIRECT / INFERENTIAL / NOT_A_CONFLICT read of a scanned contradiction agree with a lawyer's?
 *
 *   npx ts-node scripts/jev-contradiction-benchmark.ts --harvest <caseId>
 *       Writes benchmarks/jev-contradiction/harvest-<caseId>.json: that case's current
 *       contradictions with the exact input Jev sees, and an empty `expected` for a lawyer to
 *       fill in. Database only — no Jev call.
 *
 *   npx ts-node scripts/jev-contradiction-benchmark.ts [--cases benchmarks/jev-contradiction/cases.json]
 *       Scores every labelled case and writes benchmarks/jev-contradiction/<timestamp>.md.
 *       Needs TYPESAFE_API_KEY; no database.
 *
 * Labels must come from a lawyer reading the two passages. Proposed ship gate (confirm with the
 * team): no false NOT_A_CONFLICT (a real contradiction talked away is the costly error), and
 * overall accuracy >= 0.8.
 */
import * as dotenv from "dotenv";
dotenv.config();
import * as fs from "fs";
import * as path from "path";
import {
  classifyContradictionWithJev,
  ContradictionNatureInput,
  ContradictionNatureValue,
  CONTRADICTION_NATURES,
} from "../src/utils/contradiction-nature-jev";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const BENCH_DIR = path.resolve(__dirname, "..", "benchmarks", "jev-contradiction");

interface BenchCase {
  id: string;
  provenance: string;
  labelledBy: string | null;
  input: ContradictionNatureInput;
  expected: ContradictionNatureValue | null;
}

async function harvest(caseId: string) {
  const prisma = (await import("../src/lib/prisma")).default;
  const [rows, docs] = await Promise.all([
    prisma.evidenceContradiction.findMany({ where: { caseId }, orderBy: { createdAt: "asc" } }),
    prisma.document.findMany({ where: { caseId }, select: { id: true, name: true } }),
  ]);
  const name = new Map(docs.map((d) => [d.id, d.name]));
  const cases: BenchCase[] = rows.map((r, i) => ({
    id: `${caseId.slice(0, 8)}-${i + 1}`,
    provenance: `Contradiction ${r.id} on case ${caseId}, harvested ${new Date().toISOString().slice(0, 10)}`,
    labelledBy: null,
    input: {
      factKey: r.factKey,
      left: { document: name.get(r.leftDocumentId) ?? "Document A", excerpt: r.leftExcerpt, value: r.leftValue },
      right: { document: name.get(r.rightDocumentId) ?? "Document B", excerpt: r.rightExcerpt, value: r.rightValue },
    },
    expected: null,
  }));
  fs.mkdirSync(BENCH_DIR, { recursive: true });
  const out = path.join(BENCH_DIR, `harvest-${caseId}.json`);
  fs.writeFileSync(out, JSON.stringify(cases, null, 2));
  console.log(`Wrote ${cases.length} contradictions to ${out}. Label each "expected" as one of: ${CONTRADICTION_NATURES.join(", ")}.`);
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
    `# Jev contradiction benchmark — ${new Date().toISOString()}`,
    ``,
    `${cases.length} labelled of ${all.length} cases in \`${path.relative(process.cwd(), casesPath)}\`.`,
    ``,
    `| Case | Expected | Jev | Confidence | ✓ |`,
    `| --- | --- | --- | --- | --- |`,
  ];
  let correct = 0;
  let falseNoConflict = 0;
  let errors = 0;
  const misses: string[] = [];
  for (const c of cases) {
    try {
      const r = await classifyContradictionWithJev(c.input);
      const ok = r.nature === c.expected;
      if (ok) correct += 1;
      if (r.nature === "NOT_A_CONFLICT" && c.expected !== "NOT_A_CONFLICT") falseNoConflict += 1;
      if (!ok) {
        misses.push(`**${c.id}** ${c.input.factKey}: "${c.input.left.excerpt}" vs "${c.input.right.excerpt}" — expected ${c.expected}, Jev ${r.nature} (${Math.round(r.confidence * 100)}%)`);
      }
      md.push(`| ${c.id} | ${c.expected} | ${r.nature} | ${Math.round(r.confidence * 100)}% | ${ok ? "✓" : "✗"} |`);
    } catch (err) {
      errors += 1;
      md.push(`| ${c.id} | ${c.expected} | error: ${(err as Error).message} | | |`);
    }
  }
  const accuracy = cases.length ? correct / cases.length : 0;
  md.push(
    ``,
    `## Summary`,
    ``,
    `- Accuracy: ${cases.length ? `${Math.round(accuracy * 100)}% (${correct}/${cases.length})` : "n/a"}`,
    `- False NOT_A_CONFLICT: ${falseNoConflict}`,
    `- Jev errors: ${errors}`,
    ``,
    `## Proposed ship gate`,
    ``,
    `- ${falseNoConflict === 0 ? "PASS" : "FAIL"} — no false NOT_A_CONFLICT`,
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
