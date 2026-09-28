/**
 * Does Jev's assertion check give Case Reconstruction's Verified / Disputed / Unverified badges the
 * right answer? Runs checkAssertionWithJev over a directory's events-cases.json (a dated event plus
 * the passage its sourceRef would point at) and scores the support verdict, the evidence kind, and
 * the status deriveEventStatus derives from them; then runs the whole assessor over a small bundle
 * of documents, and scores the phrasing gate.
 *
 *   npx ts-node scripts/jev-reconstruction-benchmark.ts [--dir benchmarks/reconstruction]
 *
 * The directory holds the material; none is committed here (benchmarks/ is git-ignored, and test
 * material for a real case must not ship):
 *
 *   events-cases.json   { events: [...], phrasing: [...], bundle: [...] } — see the interfaces below
 *   docs/*.txt          the bundle's documents, named D01_Some_Title.txt; a bundle case's "doc": "D01"
 *                       picks the file whose name starts with "D01_"
 *
 * Needs TYPESAFE_API_KEY; no database. Ship gate, in the same spirit as the grounding verifier's:
 * no event a document plainly shows may come out DISPUTED, no event may come out VERIFIED that the label says is not, and nothing may come out DISPUTED via
 * CONTRADICTED that the label says is not contradicted — a wrong accusation is worse than a miss.
 * Writes benchmarks/jev-reconstruction/<timestamp>.md.
 */
import * as dotenv from "dotenv";
dotenv.config();
import * as fs from "fs";
import * as path from "path";
import { checkAssertionWithJev, AssertionVerdict, EvidenceKind } from "../src/utils/assertion-check";
import { deriveEventStatus, EventStatus } from "../src/utils/reconstruction-event-status";
import { assessEvent } from "../src/utils/reconstruction-event-assess";
import { extractBundleFacts } from "../src/utils/bundle-facts";
import { locateQuote, type ReconstructionEvent } from "../src/utils/case-reconstruction-events-parse";
import { isCorroboratingCheck } from "../src/utils/reconstruction-corroboration";
import { classifyEventPhrasingWithJev, EventPhrasing } from "../src/utils/event-phrasing-jev";

interface EventCase {
  id: string;
  event: string;
  passage: string;
  /** A second source's passage: checked against the same event, and if it shows the event the
   * status is derived with corroborated = true. */
  corroboratingPassage?: string;
  expectedVerdict: AssertionVerdict;
  expectedKind: EvidenceKind;
  expectedStatus: EventStatus;
  note?: string;
}

interface BundleCase {
  id: string;
  /** D01, D02, ... - which bundle document (docs/D01_*.txt) the event's quote is in. */
  doc: string;
  date: string | null;
  assertedBy: string | null;
  proposition: string;
  quote: string;
  expectedStatus: EventStatus;
  note?: string;
}

interface PhrasingCase {
  id: string;
  proposition: string;
  expected: EventPhrasing;
}

function rate(n: number, d: number) {
  return d ? `${n}/${d} (${Math.round((n / d) * 100)}%)` : "n/a";
}

async function main() {
  if (!process.env.TYPESAFE_API_KEY) {
    console.error("TYPESAFE_API_KEY is not set — nothing to benchmark.");
    process.exitCode = 1;
    return;
  }
  const dirArg = process.argv.indexOf("--dir");
  const dir = path.resolve(__dirname, "..", dirArg >= 0 ? process.argv[dirArg + 1] : path.join("benchmarks", "reconstruction"));
  const file = path.join(dir, "events-cases.json");
  if (!fs.existsSync(file)) {
    console.error(`No benchmark material at ${dir} (expected events-cases.json and docs/*.txt) — see this file's header.`);
    process.exitCode = 1;
    return;
  }
  const { events, phrasing = [], bundle = [] }: { events: EventCase[]; phrasing?: PhrasingCase[]; bundle?: BundleCase[] } = JSON.parse(fs.readFileSync(file, "utf-8"));

  let scored = 0;
  let verdictOk = 0;
  let kindOk = 0;
  let statusScored = 0;
  let statusOk = 0;
  let falseDisputed = 0;
  let falseVerified = 0;
  let falseContradicted = 0;
  const misses: string[] = [];
  const md = [`| Case | Verdict (exp → got) | Kind (exp → got) | Status (exp → got) |`, `| --- | --- | --- | --- |`];

  for (const c of events) {
    try {
      const got = await checkAssertionWithJev(c.event, c.passage, c.id);
      const corroborated = c.corroboratingPassage ? isCorroboratingCheck(await checkAssertionWithJev(c.event, c.corroboratingPassage, `${c.id}/corroboration`), c.corroboratingPassage) : false;
      const status = deriveEventStatus(got, { corroborated });
      scored++;
      const vOk = got.verdict === c.expectedVerdict;
      const kOk = got.evidenceKind === c.expectedKind;
      if (vOk) verdictOk++;
      if (kOk) kindOk++;
      let sCell = `${c.expectedStatus} → ${status}`;
      statusScored++;
      if (status === c.expectedStatus) statusOk++;
      else {
        sCell += " ✗";
        if (status === "DISPUTED") falseDisputed++;
        if (status === "VERIFIED") falseVerified++;
      }
      if (got.verdict === "CONTRADICTED" && c.expectedVerdict !== "CONTRADICTED") falseContradicted++;
      if (!vOk) misses.push(`${c.id}: expected verdict ${c.expectedVerdict}, got ${got.verdict} (${Math.round(got.confidence * 100)}%) — ${c.event}`);
      if (!kOk) misses.push(`${c.id}: expected kind ${c.expectedKind}, got ${got.evidenceKind} (${Math.round(got.kindConfidence * 100)}%) — ${c.event}`);
      md.push(
        `| ${c.id} | ${c.expectedVerdict} → ${got.verdict} (${Math.round(got.confidence * 100)}%)${vOk ? "" : " ✗"} | ${c.expectedKind} → ${got.evidenceKind}${kOk ? "" : " ✗"} | ${sCell} |`,
      );
      console.log(`${c.id}: ${c.expectedVerdict} → ${got.verdict}${vOk ? "" : " ✗"} | ${got.evidenceKind}${kOk ? "" : ` ✗ exp ${c.expectedKind}`} | ${sCell}`);
    } catch (err) {
      md.push(`| ${c.id} | _error_ | — | — |`);
      console.warn(`${c.id}: Jev error — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Phrasing gate: does Jev catch a proposition that only reports a claim? Scored after the floor
  // (what the service would act on), so an unsure ALLEGATION counts as FACT.
  let phrasingOk = 0;
  let phrasingScored = 0;
  let falseAllegation = 0;
  let allegationsSeen = 0;
  let allegationsCaught = 0;
  const phrasingMd = [`| Case | Proposition | Expected → got |`, `| --- | --- | --- |`];
  for (const c of phrasing) {
    try {
      const got = await classifyEventPhrasingWithJev(c.proposition);
      phrasingScored++;
      const ok = got.phrasing === c.expected;
      if (ok) phrasingOk++;
      if (c.expected === "ALLEGATION") {
        allegationsSeen++;
        if (ok) allegationsCaught++;
      } else if (got.phrasing === "ALLEGATION") falseAllegation++;
      const pct = Math.round(got.confidence * 100);
      phrasingMd.push(`| ${c.id} | ${c.proposition} | ${c.expected} → ${got.phrasing} (raw ${got.rawPhrasing} ${pct}%)${ok ? "" : " ✗"} |`);
      console.log(`${c.id}: ${c.expected} → ${got.phrasing} (raw ${got.rawPhrasing} ${pct}%)${ok ? "" : " ✗"}`);
      if (!ok) misses.push(`${c.id}: expected ${c.expected}, got ${got.phrasing} (raw ${got.rawPhrasing} ${pct}%) — ${c.proposition}`);
    } catch (err) {
      phrasingMd.push(`| ${c.id} | ${c.proposition} | _error_ |`);
      console.warn(`${c.id}: Jev error — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Whole assessor on the bundle: phrasing gate, own-source check, and the sweep of what other
  // documents say on the same date - what the per-event cases cannot show.
  const docsDir = path.join(dir, "docs");
  const bundleFiles = fs.existsSync(docsDir) ? fs.readdirSync(docsDir).filter((f) => f.toLowerCase().endsWith(".txt")).sort() : [];
  const docId = (label: string) => bundleFiles.find((f) => f.startsWith(`${label}_`)) ?? label;
  const fullTextByDocId = new Map(bundleFiles.map((f) => [f, fs.readFileSync(path.join(docsDir, f), "utf-8")]));
  const bundleFacts = bundleFiles.flatMap((f) =>
    extractBundleFacts([{ id: `${f}#0`, caseDocumentId: f, chunkIndex: 0, pageNumber: 1, chunkText: fullTextByDocId.get(f)! }], { numericDayFirst: false }),
  );
  const assessCtx = { facts: bundleFacts, fullTextByDocId, docNames: new Map(bundleFiles.map((f) => [f, f.replace(/\.txt$/i, "").replace(/_/g, " ")])) };
  let bundleOk = 0;
  let bundleScored = 0;
  const bundleMd = [`| Case | Event | Expected -> got | Note |`, `| --- | --- | --- | --- |`];
  for (const c of bundle) {
    const text = fullTextByDocId.get(docId(c.doc));
    if (text === undefined || locateQuote(text, c.quote) < 0) {
      bundleMd.push(`| ${c.id} | ${c.proposition} | _no such document or quote not in ${c.doc}_ | |`);
      console.warn(`${c.id}: quote not found in ${c.doc} - fix the case`);
      continue;
    }
    const event: ReconstructionEvent = { index: 0, date: c.date, proposition: c.proposition, assertedBy: c.assertedBy, sourceRef: { docId: docId(c.doc), page: 1, quote: c.quote } };
    try {
      const got = await assessEvent(event, assessCtx, { classifyPhrasing: classifyEventPhrasingWithJev, checkAssertion: checkAssertionWithJev });
      bundleScored++;
      const ok = got.status === c.expectedStatus;
      if (ok) bundleOk++;
      else {
        if (got.status === "DISPUTED") falseDisputed++;
        if (got.status === "VERIFIED") falseVerified++;
        misses.push(`${c.id}: expected ${c.expectedStatus}, got ${got.status} - ${c.proposition} (${got.statusNote})`);
      }
      const extra = [got.corroboratedBy?.length ? `corroborated by ${got.corroboratedBy.join(", ")}` : "", got.contradictedBy?.length ? `contradicted by ${got.contradictedBy.join(", ")}` : ""].filter(Boolean).join("; ");
      bundleMd.push(`| ${c.id} | ${c.proposition} | ${c.expectedStatus} -> ${got.status}${ok ? "" : " X"} | ${extra || (c.note ?? "")} |`);
      console.log(`${c.id}: ${c.expectedStatus} -> ${got.status}${ok ? "" : " X"}${extra ? `  (${extra})` : ""}`);
    } catch (err) {
      bundleMd.push(`| ${c.id} | ${c.proposition} | _error_ | |`);
      console.warn(`${c.id}: Jev error - ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const gate = [
    ``,
    `## Ship gate`,
    ``,
    `- No event wrongly DISPUTED: **${scored ? (falseDisputed === 0 ? "PASS" : `FAIL (${falseDisputed})`) : "not run"}**`,
    `- No event wrongly VERIFIED (a badge that overstates the record is as bad as a false accusation): **${scored ? (falseVerified === 0 ? "PASS" : `FAIL (${falseVerified})`) : "not run"}**`,
    `- No fact-phrased event flagged ALLEGATION (it would skip a real check): **${phrasingScored ? (falseAllegation === 0 ? "PASS" : `FAIL (${falseAllegation})`) : "not run"}**`,
    `- Allegation-phrased events caught: **${rate(allegationsCaught, allegationsSeen)}**`,
    `- No false CONTRADICTED verdicts: **${scored ? (falseContradicted === 0 ? "PASS" : `FAIL (${falseContradicted})`) : "not run"}**`,
  ];
  const out = [
    `# Case Reconstruction event-status benchmark`,
    ``,
    `Run: ${new Date().toISOString()}`,
    ``,
    ...md,
    ``,
    `## Whole assessor on the bundle (own source + other documents)`,
    ``,
    ...bundleMd,
    ``,
    `- Bundle status accuracy: ${rate(bundleOk, bundleScored)}`,
    ``,
    `## Phrasing (Jev gate before the source check)`,
    ``,
    ...phrasingMd,
    ``,
    `- Phrasing accuracy: ${rate(phrasingOk, phrasingScored)}`,
    ``,
    `- Verdict accuracy: ${rate(verdictOk, scored)}`,
    `- Evidence-kind accuracy: ${rate(kindOk, scored)}`,
    `- Status accuracy: ${rate(statusOk, statusScored)}`,
    ...gate,
    ...(misses.length ? [``, `## Misses`, ``, ...misses.map((m) => `- ${m}`)] : []),
  ].join("\n");

  const outDir = path.resolve(__dirname, "..", "benchmarks", "jev-reconstruction");
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
  .finally(() => {
    setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
  });
