/**
 * Stage 6, step 29 of the mind map plan — is Jev right about case mind map nodes? Scores
 * checkAssertionWithJev (via mind-map-jev.ts's passage loading) against lawyer-labelled nodes, the
 * gate for switching USE_JEV_MINDMAP on.
 *
 *   npx ts-node scripts/jev-mind-map-benchmark.ts --export <caseId>   # write nodes to label
 *   npx ts-node scripts/jev-mind-map-benchmark.ts                     # score the labelled file
 *
 * --export needs the database: it takes the case's document-built map (CaseMindMap), and writes
 * every node that cites a document — with the passage mind-map-jev.ts would hand Jev — to
 * benchmarks/mind-map/nodes.json, `expected` left null for a lawyer to fill in (SUPPORTED if the
 * passage bears the node out, UNSUPPORTED if it doesn't establish it, CONTRADICTED if it says the
 * opposite). Existing entries are kept; new ones are appended.
 *
 * Scoring needs TYPESAFE_API_KEY only — the passage is stored in the file, so a labelled set runs
 * anywhere. Rows with `expected: null` are skipped.
 *
 * Ship gate, same as the grounding check's: no false CONTRADICTED verdicts (a wrong accusation is
 * worse than a missed one), over at least MIN_LABELLED labelled nodes. Writes
 * benchmarks/jev-mind-map/<timestamp>.md.
 */
import * as dotenv from "dotenv";
dotenv.config();
import * as fs from "fs";
import * as path from "path";
import prisma from "../src/lib/prisma";
import MindMapRepo from "../src/repositories/mind-map.repository";
import DocumentRepo from "../src/repositories/document.repository";
import { checkAssertionWithJev, AssertionVerdict } from "../src/utils/assertion-check";
import { loadCitedPassage, nodeAssertion } from "../src/utils/mind-map-jev";
import { MindMapItem } from "../src/utils/response-parser";

const LABEL_FILE = path.resolve(__dirname, "..", "benchmarks", "mind-map", "nodes.json");
/** Fewer labelled nodes than this and the gate reports "not enough labels" instead of PASS. */
const MIN_LABELLED = 20;

interface LabelledNode {
  /** `<caseId>:<nodeId>` — stable across re-exports, so labels aren't duplicated. */
  id: string;
  assertion: string;
  citation: string;
  passage: string;
  located: boolean;
  expected: AssertionVerdict | null;
  /** Who labelled it and from what — e.g. "A. Cruz, 2026-09-26, read p. 2 of the note". */
  provenance: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readLabels(): LabelledNode[] {
  return fs.existsSync(LABEL_FILE) ? (JSON.parse(fs.readFileSync(LABEL_FILE, "utf8")) as LabelledNode[]) : [];
}

async function exportCase(caseId: string) {
  const map = await MindMapRepo.findCaseMap(caseId);
  if (!map) throw new Error(`Case ${caseId} has no document-built mind map yet.`);
  const names = new Map((await DocumentRepo.listAllByCase(caseId)).map((d) => [d.id, d.name]));
  const existing = readLabels();
  const known = new Set(existing.map((n) => n.id));
  const added: LabelledNode[] = [];
  // Every cited node, not just the 60 a build would check (nodesToCheck) — labelling wants the
  // whole set.
  const cited: MindMapItem[] = [];
  const walk = (node: MindMapItem) => {
    if (node.sources?.length) cited.push(node);
    node.children.forEach(walk);
  };
  walk(map.data as unknown as MindMapItem);
  for (const node of cited) {
    const id = `${caseId}:${node.id}`;
    if (known.has(id)) continue;
    const passage = await loadCitedPassage(node);
    if (!passage) continue;
    const source = node.sources![0]!;
    added.push({
      id,
      assertion: nodeAssertion(node),
      citation: [names.get(source.documentId) ?? source.documentId, source.page ? `p. ${source.page}` : null].filter(Boolean).join(", "),
      passage: passage.passage,
      located: passage.located,
      expected: null,
      provenance: "",
    });
  }
  fs.mkdirSync(path.dirname(LABEL_FILE), { recursive: true });
  fs.writeFileSync(LABEL_FILE, JSON.stringify([...existing, ...added], null, 2) + "\n");
  console.log(`Added ${added.length} nodes from case ${caseId} to ${LABEL_FILE} (${existing.length} already there). Fill in "expected" and "provenance".`);
}

async function score() {
  const labelled = readLabels().filter((n) => n.expected !== null);
  if (!labelled.length) {
    console.log(`No labelled nodes in ${LABEL_FILE}. Run with --export <caseId> first, then fill in "expected".`);
    return;
  }
  if (!process.env.TYPESAFE_API_KEY) {
    console.log("TYPESAFE_API_KEY is not set — can't ask Jev. Skipping.");
    return;
  }

  const rows: string[] = [`| Node | Expected | Jev | ✓ | Passage |`, `| --- | --- | --- | --- | --- |`];
  const misses: string[] = [];
  const perVerdict: Record<string, { n: number; correct: number }> = {};
  let correct = 0;
  let scored = 0;
  let falseContradicted = 0;
  for (const node of labelled) {
    try {
      const got = await checkAssertionWithJev(node.assertion, node.passage, node.citation);
      scored++;
      const ok = got.verdict === node.expected;
      perVerdict[node.expected!] = perVerdict[node.expected!] ?? { n: 0, correct: 0 };
      perVerdict[node.expected!].n++;
      if (ok) {
        correct++;
        perVerdict[node.expected!].correct++;
      } else {
        misses.push(`${node.id}: expected ${node.expected}, got ${got.verdict} (${Math.round(got.confidence * 100)}%) — ${node.assertion.slice(0, 80)}`);
        if (got.verdict === "CONTRADICTED") falseContradicted++;
      }
      rows.push(`| ${node.id} | ${node.expected} | ${got.verdict} (${Math.round(got.confidence * 100)}%) | ${ok ? "yes" : "**no**"} | ${node.located ? "cited page" : "fallback chunks"} |`);
      console.log(`${node.id}: ${node.expected} → ${got.verdict} (${Math.round(got.confidence * 100)}%)${ok ? "" : " ✗"}`);
    } catch (err) {
      rows.push(`| ${node.id} | ${node.expected} | _error_ | — | — |`);
      console.warn(`${node.id}: Jev error — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const rate = (a: number, b: number) => (b ? `${a}/${b} (${Math.round((a / b) * 100)}%)` : "n/a");
  const gate =
    scored < MIN_LABELLED
      ? `NOT ENOUGH LABELS (${scored} scored, need ${MIN_LABELLED})`
      : falseContradicted === 0
        ? "PASS"
        : `FAIL (${falseContradicted} false CONTRADICTED)`;
  const out = [
    `# Jev mind map benchmark`,
    ``,
    `Run: ${new Date().toISOString()} · labels: ${LABEL_FILE}`,
    ``,
    ...rows,
    ``,
    `- Accuracy: ${rate(correct, scored)}`,
    ...Object.entries(perVerdict).sort().map(([k, v]) => `- ${k}: ${rate(v.correct, v.n)}`),
    ``,
    `## Ship gate`,
    ``,
    `- No false CONTRADICTED verdicts over ≥ ${MIN_LABELLED} labelled nodes: **${gate}**`,
    ...(misses.length ? [``, `## Misses`, ``, ...misses.map((m) => `- ${m}`)] : []),
  ].join("\n");
  const outDir = path.resolve(__dirname, "..", "benchmarks", "jev-mind-map");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  fs.writeFileSync(outFile, out);
  console.log(`\nShip gate: ${gate}\nWritten to ${outFile}`);
}

async function main() {
  const caseId = arg("export");
  if (caseId) await exportCase(caseId);
  else await score();
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
    setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
  });
