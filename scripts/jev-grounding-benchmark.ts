/**
 * Phase 1, step 2 of docs/plans/grounding-verifier.md — does the grounding verifier detect what
 * the examiner detected? Scores benchmarks/brackenmoor/grounding-cases.json, whose labels were
 * harvested from the grader's own findings on the twelve answers of 21 September, so this is
 * measured against an independent reading of the same text rather than against my own intuition.
 *
 *   npx ts-node scripts/jev-grounding-benchmark.ts                # both halves
 *   npx ts-node scripts/jev-grounding-benchmark.ts --only absence # no DB, no Jev, no network
 *
 * The absence half is pure parser + classifier: no AI, no database, runs anywhere. The assertion
 * half needs the seeded Brackenmoor case (for the cited passages) and TYPESAFE_API_KEY (for the
 * Jev judgment), and is skipped with a message rather than a crash when either is missing.
 *
 * Ship gate from the plan: no false CONTRADICTED verdicts, and FALSE_ABSENCE recall above 0.8.
 * Writes benchmarks/jev-grounding/<timestamp>.md.
 */
import * as dotenv from "dotenv";
dotenv.config();
import * as fs from "fs";
import * as path from "path";
import prisma from "../src/lib/prisma";
import DocumentChunkRepo from "../src/repositories/document-chunk.repository";
import { parseAbsenceClaims, classifyAbsence, buildBundleView, parseCitations, AbsenceVerdict } from "../src/utils/answer-grounding";
import { checkAssertionWithJev, AssertionVerdict, EvidenceKind } from "../src/utils/assertion-check";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const BENCH_DIR = path.resolve(__dirname, "..", "benchmarks", "brackenmoor");
const only = arg("only");

interface AbsenceCase {
  id: string;
  sentence: string;
  supplied: string[];
  expected: AbsenceVerdict | "NOT_A_CLAIM";
  provenance: string;
}
interface AssertionCase {
  id: string;
  assertion: string;
  citation: string;
  expected: AssertionVerdict;
  expectedKind: EvidenceKind;
  provenance: string;
}

/** Bundle labels D01–D20 with the filenames the seeded case uses, so the absence half needs no DB. */
const BUNDLE_FILES = fs.existsSync(path.join(BENCH_DIR, "docs"))
  ? fs.readdirSync(path.join(BENCH_DIR, "docs")).filter((f) => f.toLowerCase().endsWith(".pdf"))
  : [];

/**
 * A window of the document around the cited locator. Exact passage resolution is an open question
 * in the plan (a merged bundle has no exhibit boundaries at all); this is the honest approximation
 * — find the locator's marker and take the text around it, else the head of the document — and the
 * benchmark reports how often it fell back, because a fallback makes the Jev verdict weaker
 * evidence than a hit.
 */
function extractPassage(text: string, locator: string | undefined, budget = 3500): { passage: string; located: boolean } {
  if (!text) return { passage: "", located: false };
  if (locator) {
    const num = locator.match(/\d+(?:\.\d+)*/)?.[0];
    const word = /part/i.test(locator) ? "Part" : /appendix/i.test(locator) ? "Appendix" : /item/i.test(locator) ? "item" : "para";
    if (num) {
      const patterns = [
        new RegExp(`\\b${word}\\s*${num.replace(".", "\\.")}\\b`, "i"),
        new RegExp(`(^|\\n)\\s*${num.replace(".", "\\.")}[.)\\s]`, "m"),
      ];
      for (const re of patterns) {
        const m = re.exec(text);
        if (m && m.index >= 0) {
          const start = Math.max(0, m.index - 200);
          return { passage: text.slice(start, start + budget), located: true };
        }
      }
    }
  }
  return { passage: text.slice(0, budget), located: false };
}

async function bundleTexts(): Promise<Map<string, string>> {
  const q = JSON.parse(fs.readFileSync(path.join(BENCH_DIR, "questions.json"), "utf-8"));
  const caseRow = await prisma.case.findFirst({ where: { caseName: q.caseName } });
  if (!caseRow) throw new Error(`Seeded case "${q.caseName}" not found — run scripts/seed-benchmark.ts`);
  const docs = await prisma.document.findMany({ where: { caseId: caseRow.id, ragStatus: "READY" }, select: { id: true, name: true } });
  const texts = await DocumentChunkRepo.findFullTextsByDocuments(docs.map((d) => d.id));
  const byLabel = new Map<string, string>();
  for (const d of docs) {
    const label = d.name.match(/\bD(\d{1,2})(?!\d)/i);
    if (label) byLabel.set(`D${label[1].padStart(2, "0")}`, texts.get(d.id) ?? "");
  }
  return byLabel;
}

function rate(n: number, d: number) {
  return d ? `${n}/${d} (${Math.round((n / d) * 100)}%)` : "n/a";
}

async function main() {
  const cases = JSON.parse(fs.readFileSync(path.join(BENCH_DIR, "grounding-cases.json"), "utf-8"));
  const absenceCases: AbsenceCase[] = cases.absence ?? [];
  const assertionCases: AssertionCase[] = cases.assertions ?? [];
  const lines: string[] = [];
  const md: string[] = [];

  // ── absence half: parser + classifier, no AI ────────────────────────────────
  let absCorrect = 0;
  const absConfusion: string[] = [];
  const absCounts: Record<string, { n: number; correct: number }> = {};
  md.push(`## Absence claims (parser + classifier, no AI)`, ``, `| Case | Expected | Got | ✓ |`, `| --- | --- | --- | --- |`);
  for (const c of absenceCases) {
    const view = buildBundleView(
      BUNDLE_FILES.map((name) => ({ id: name, name })),
      BUNDLE_FILES.filter((name) => c.supplied.some((label) => name.toUpperCase().startsWith(label))),
    );
    const claims = parseAbsenceClaims(c.sentence);
    const got: AbsenceVerdict | "NOT_A_CLAIM" = claims.length === 0 ? "NOT_A_CLAIM" : classifyAbsence(claims[0], view).verdict;
    const ok = got === c.expected;
    absCounts[c.expected] = absCounts[c.expected] ?? { n: 0, correct: 0 };
    absCounts[c.expected].n++;
    if (ok) {
      absCorrect++;
      absCounts[c.expected].correct++;
    } else absConfusion.push(`${c.id}: expected ${c.expected}, got ${got} — ${c.sentence.slice(0, 90)}`);
    md.push(`| ${c.id} | ${c.expected} | ${got} | ${ok ? "yes" : "**no**"} |`);
    lines.push(`${c.id}: ${c.expected} → ${got}${ok ? "" : "  ✗"}`);
  }
  md.push(``, `- Accuracy: ${rate(absCorrect, absenceCases.length)}`, ...Object.entries(absCounts).sort().map(([k, v]) => `- ${k}: ${rate(v.correct, v.n)}`));
  console.log(lines.join("\n"));
  console.log(`\nabsence: ${rate(absCorrect, absenceCases.length)}`);

  // ── assertion half: needs the bundle text and Jev ───────────────────────────
  let asrCorrect = 0;
  let kindCorrect = 0;
  let scored = 0;
  let fellBack = 0;
  let falseContradicted = 0;
  const asrConfusion: string[] = [];
  const asrCounts: Record<string, { n: number; correct: number }> = {};

  if (only === "absence") {
    md.push(``, `## Assertions`, ``, `Skipped (\`--only absence\`).`);
  } else {
    let texts: Map<string, string>;
    try {
      texts = await bundleTexts();
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      console.warn(`\nassertion half skipped: ${why}`);
      md.push(``, `## Assertions`, ``, `Skipped — ${why}`);
      texts = new Map();
    }
    if (texts.size) {
      md.push(``, `## Assertions (Jev over the cited passage)`, ``, `| Case | Expected | Jev | ✓ | Expected kind | Jev kind | ✓ | Passage |`, `| --- | --- | --- | --- | --- | --- | --- | --- |`);
      for (const c of assertionCases) {
        const ref = parseCitations(c.citation)[0];
        const text = ref ? texts.get(ref.document) ?? "" : "";
        if (!text) {
          md.push(`| ${c.id} | ${c.expected} | _no text_ | — | ${c.expectedKind} | — | — | — |`);
          continue;
        }
        const { passage, located } = extractPassage(text, ref?.locator);
        if (!located) fellBack++;
        try {
          const got = await checkAssertionWithJev(c.assertion, passage, c.citation);
          scored++;
          const ok = got.verdict === c.expected;
          const kindOk = got.evidenceKind === c.expectedKind;
          asrCounts[c.expected] = asrCounts[c.expected] ?? { n: 0, correct: 0 };
          asrCounts[c.expected].n++;
          if (ok) {
            asrCorrect++;
            asrCounts[c.expected].correct++;
          } else {
            asrConfusion.push(`${c.id}: expected ${c.expected}, got ${got.verdict} (${Math.round(got.confidence * 100)}%) — ${c.assertion.slice(0, 80)}`);
            if (got.verdict === "CONTRADICTED") falseContradicted++;
          }
          if (kindOk) kindCorrect++;
          md.push(
            `| ${c.id} | ${c.expected} | ${got.verdict} (${Math.round(got.confidence * 100)}%) | ${ok ? "yes" : "**no**"} | ${c.expectedKind} | ${got.evidenceKind} | ${kindOk ? "yes" : "no"} | ${located ? "located" : "head"} |`,
          );
          console.log(`${c.id}: ${c.expected} → ${got.verdict} (${Math.round(got.confidence * 100)}%)${ok ? "" : " ✗"} | kind ${got.evidenceKind}${kindOk ? "" : ` ✗ exp ${c.expectedKind}`}`);
        } catch (err) {
          md.push(`| ${c.id} | ${c.expected} | _error_ | — | ${c.expectedKind} | — | — | — |`);
          console.warn(`${c.id}: Jev error — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      md.push(
        ``,
        `- Support accuracy: ${rate(asrCorrect, scored)}`,
        `- Evidence-kind accuracy (criterion E): ${rate(kindCorrect, scored)}`,
        `- Passage located by locator (rest fell back to the head of the document): ${rate(scored - fellBack, scored)}`,
        ...Object.entries(asrCounts).sort().map(([k, v]) => `- ${k}: ${rate(v.correct, v.n)}`),
      );
    }
  }

  const falseAbsence = absCounts.FALSE_ABSENCE;
  const gate = [
    ``,
    `## Ship gate (docs/plans/grounding-verifier.md)`,
    ``,
    `- No false CONTRADICTED verdicts: **${scored ? (falseContradicted === 0 ? "PASS" : `FAIL (${falseContradicted})`) : "not run"}**`,
    `- FALSE_ABSENCE recall > 0.8: **${falseAbsence ? (falseAbsence.correct / falseAbsence.n > 0.8 ? "PASS" : "FAIL") : "n/a"}** (${falseAbsence ? rate(falseAbsence.correct, falseAbsence.n) : "n/a"})`,
  ];

  const out = [
    `# Grounding verifier benchmark`,
    ``,
    `Run: ${new Date().toISOString()}`,
    ``,
    `Labels harvested from the grader's findings on the twelve answers of 2026-09-21; every case`,
    `carries that provenance in grounding-cases.json.`,
    ``,
    ...md,
    ...gate,
    ...(absConfusion.length ? [``, `## Absence misses`, ``, ...absConfusion.map((x) => `- ${x}`)] : []),
    ...(asrConfusion.length ? [``, `## Assertion misses`, ``, ...asrConfusion.map((x) => `- ${x}`)] : []),
  ].join("\n");

  const outDir = path.resolve(__dirname, "..", "benchmarks", "jev-grounding");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  fs.writeFileSync(outFile, out);
  console.log(`\n${gate.join("\n")}\n\nWritten to ${outFile}`);
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
