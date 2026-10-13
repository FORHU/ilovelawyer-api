/**
 * #410: does the order of a Choice's options change Jev's verdict? TypeSafe's notes on jev-1.13
 * say the model leans toward the first option, and every verification question lists the passing
 * answer first. This sends each labelled case three times — today's order twice (the two runs'
 * disagreement is the noise floor) and the reversed order once — through the same request
 * builders production uses, so only the option order differs.
 *
 *   npx ts-node scripts/jev-option-order-benchmark.ts [--only validity|proposition|assertion]
 *
 * Validity and proposition use the hand-written sets in their benchmark scripts (no DB). The
 * assertion half reads the seeded Brackenmoor case's documents for the cited passages, read-only,
 * and is skipped when that case isn't there. Writes benchmarks/jev-option-order/<timestamp>.md.
 */
import * as dotenv from "dotenv";
dotenv.config();

import * as fs from "fs";
import * as path from "path";
import prisma from "../src/lib/prisma";
import { jevAsk } from "../src/utils/typesafeClient";
import { JEV_VALIDITY_VERDICTS, validityRequest } from "../src/utils/citation-validity";
import { JEV_PROPOSITION_TYPES, propositionRequest } from "../src/utils/citation-proposition";
import { ASSERTION_VERDICTS, CONTRADICTION_MIN_CONFIDENCE, assertionRequest } from "../src/utils/assertion-check";
import { parseCitations } from "../src/utils/answer-grounding";
import { CASES as VALIDITY_CASES } from "./jev-validity-benchmark";
import { HAND_WRITTEN as PROPOSITION_CASES } from "./jev-proposition-benchmark";
import { AssertionCase, BENCH_DIR as BRACKENMOOR_DIR, bundleTexts, extractPassage } from "./jev-grounding-benchmark";

const CONCURRENCY = 4;
const only = (() => {
  const i = process.argv.indexOf("--only");
  return i >= 0 ? process.argv[i + 1] : undefined;
})();

type Run = "normalA" | "normalB" | "reversed";
const RUNS: Run[] = ["normalA", "normalB", "reversed"];

interface Answer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

interface Item {
  id: string;
  expected: string;
  ask: (order: readonly string[]) => Promise<Answer>;
  /** Production's own mapping from Jev's answer to the verdict it acts on, e.g. a confidence floor. */
  verdict?: (a: Answer) => string;
}

interface Check {
  name: string;
  options: readonly string[];
  items: Item[];
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const answerOf = (a: any): Answer => ({ choice: a.choice, confidence: a.confidence, probabilities: a.probabilities ?? {} });
const pct = (n: number, d: number) => (d ? `${n}/${d} (${Math.round((n / d) * 100)}%)` : "n/a");
const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);

function validityCheck(): Check {
  return {
    name: "citation validity",
    options: JEV_VALIDITY_VERDICTS,
    items: VALIDITY_CASES.map((c) => ({
      id: c.label,
      expected: c.expected,
      ask: async (order) =>
        answerOf((await jevAsk("option-order:validity", validityRequest(c.quotedText, c.officialText, order as any))).answers.validity),
    })),
  };
}

function propositionCheck(): Check {
  return {
    name: "citation type",
    options: JEV_PROPOSITION_TYPES,
    items: PROPOSITION_CASES.filter((c) => c.expected).map((c) => ({
      id: c.label,
      expected: c.expected!,
      ask: async (order) =>
        answerOf((await jevAsk("option-order:proposition", propositionRequest(c.quotedText, c.officialText, order as any))).answers.propositionType),
    })),
  };
}

async function assertionCheck(): Promise<Check | string> {
  const file = path.join(BRACKENMOOR_DIR, "grounding-cases.json");
  if (!fs.existsSync(file)) return `no ${path.relative(process.cwd(), file)}`;
  const cases: AssertionCase[] = JSON.parse(fs.readFileSync(file, "utf-8")).assertions ?? [];
  let texts: Map<string, string>;
  try {
    texts = await bundleTexts();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  const items: Item[] = [];
  for (const c of cases) {
    const ref = parseCitations(c.citation)[0];
    const text = ref ? texts.get(ref.document) ?? "" : "";
    if (!text) continue;
    const { passage } = extractPassage(text, ref?.locator);
    items.push({
      id: c.id,
      expected: c.expected,
      ask: async (order) =>
        answerOf((await jevAsk("option-order:assertion", assertionRequest(c.assertion, passage, c.citation, order as any))).answers.support),
      // Same floor checkAssertionWithJev applies before a verdict is shown.
      verdict: (a) => (a.choice === "CONTRADICTED" && a.confidence < CONTRADICTION_MIN_CONFIDENCE ? "UNSUPPORTED" : a.choice),
    });
  }
  return { name: "assertion check (grounding)", options: ASSERTION_VERDICTS, items };
}

async function runCheck(check: Check, md: string[]) {
  const normal = check.options;
  const reversed = [...normal].reverse();
  const pass = normal[0];
  console.log(`\n${check.name}: ${check.items.length} cases × 3 runs`);

  const results = await pool(check.items, CONCURRENCY, async (item) => {
    const out: Partial<Record<Run, Answer | null>> = {};
    for (const run of RUNS) {
      try {
        out[run] = await item.ask(run === "reversed" ? reversed : normal);
      } catch {
        out[run] = null;
      }
    }
    return { item, out: out as Record<Run, Answer | null> };
  });

  const verdictOf = (item: Item, a: Answer | null) => (a ? (item.verdict ? item.verdict(a) : a.choice) : null);
  const complete = results.filter((r) => RUNS.every((run) => r.out[run]));
  const correct = (run: Run) => complete.filter((r) => verdictOf(r.item, r.out[run]) === r.item.expected).length;
  const noiseFlips = complete.filter((r) => r.out.normalA!.choice !== r.out.normalB!.choice);
  const orderFlips = complete.filter((r) => r.out.normalA!.choice !== r.out.reversed!.choice);
  const towardPass = orderFlips.filter((r) => r.out.normalA!.choice === pass).length;
  const pPassNormal = avg(complete.map((r) => (r.out.normalA!.probabilities[pass] + r.out.normalB!.probabilities[pass]) / 2));
  const pPassReversed = avg(complete.map((r) => r.out.reversed!.probabilities[pass]));

  md.push(
    ``,
    `## ${check.name}`,
    ``,
    `Today's order: ${normal.join(", ")} · reversed: ${reversed.join(", ")} · "pass" answer: **${pass}**`,
    ``,
    `| | Today's order (run A) | Today's order (run B) | Reversed |`,
    `| --- | --- | --- | --- |`,
    `| Accuracy | ${pct(correct("normalA"), complete.length)} | ${pct(correct("normalB"), complete.length)} | ${pct(correct("reversed"), complete.length)} |`,
    ``,
    `- Cases scored: ${complete.length} of ${check.items.length}${complete.length < check.items.length ? ` (${check.items.length - complete.length} had a failed call)` : ""}`,
    `- Answers that changed between the two identical runs (noise): ${pct(noiseFlips.length, complete.length)}`,
    `- Answers that changed when only the order was reversed: ${pct(orderFlips.length, complete.length)}${orderFlips.length ? `, of which ${towardPass} had picked "${pass}" in today's order` : ""}`,
    `- Average probability of "${pass}": ${(pPassNormal * 100).toFixed(1)}% listed first vs ${(pPassReversed * 100).toFixed(1)}% listed last (difference ${((pPassNormal - pPassReversed) * 100).toFixed(1)} points)`,
  );
  if (orderFlips.length || noiseFlips.length) {
    md.push(``, `| Case | Expected | Run A | Run B | Reversed |`, `| --- | --- | --- | --- | --- |`);
    for (const r of complete.filter((x) => orderFlips.includes(x) || noiseFlips.includes(x))) {
      const cell = (run: Run) => `${r.out[run]!.choice} (${Math.round(r.out[run]!.confidence * 100)}%)`;
      md.push(`| ${r.item.id} | ${r.item.expected} | ${cell("normalA")} | ${cell("normalB")} | ${cell("reversed")} |`);
    }
  }
  console.log(md.slice(-12).join("\n"));
}

async function main() {
  const md: string[] = [`# Jev option-order benchmark (#410)`, ``, `Run: ${new Date().toISOString()}`];
  if (!only || only === "validity") await runCheck(validityCheck(), md);
  if (!only || only === "proposition") await runCheck(propositionCheck(), md);
  if (!only || only === "assertion") {
    const check = await assertionCheck();
    if (typeof check === "string") {
      console.warn(`\nassertion check skipped: ${check}`);
      md.push(``, `## assertion check (grounding)`, ``, `Skipped: ${check}`);
    } else {
      await runCheck(check, md);
    }
  }
  const dir = path.resolve(__dirname, "..", "benchmarks", "jev-option-order");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  fs.writeFileSync(file, md.join("\n") + "\n");
  console.log(`\nWritten to ${path.relative(process.cwd(), file)}`);
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect().catch(() => {});
      setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
    });
}
