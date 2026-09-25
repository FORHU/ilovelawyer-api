/**
 * Pilot benchmark for classifyOutlookWithJev (src/utils/case-outlook-jev.ts) — NOT wired into
 * CaseOutlookAiSvc. Answers one question before any production change: given the same structured
 * signals CaseOutlookAiSvc already assembles (findings, open risks, contradictions, deadlines),
 * can Jev's choice/score primitives classify OutlookBand + ConfidenceLevel well enough to be worth
 * pursuing further, versus the current single chat-wonder call that reads raw document text and
 * writes band + confidence + rationale + drivers together?
 *
 * This only tests the classification half — Jev has no path to also write a grounded, cited
 * rationale, so it can never fully replace the chat-wonder call. It can only ever be a second
 * opinion or a pre-classification step.
 *
 *   npx ts-node scripts/jev-case-outlook-benchmark.ts
 *
 * Requires TYPESAFE_API_KEY in .env. No chat-wonder, no database — Jev only, same as
 * jev-uk-triage-benchmark.ts. Writes benchmarks/jev-case-outlook/<timestamp>.md.
 */
import * as dotenv from "dotenv";
dotenv.config();
import * as fs from "fs";
import * as path from "path";
import { OutlookBand, ConfidenceLevel, RiskSeverity } from "@prisma/client";
import { classifyOutlookWithJev, OutlookJevInput } from "../src/utils/case-outlook-jev";
import { OUTLOOK_MIN_READY_DOCS, OUTLOOK_LOW_CONFIDENCE_RISK_SEVERITIES } from "../src/constants";

interface Fixture extends OutlookJevInput {
  label: string;
  expectedBand: OutlookBand;
  /** Confidence a careful lawyer would assign reading the same signals — before the code-side
   * thin-evidence guard is applied. */
  expectedConfidence: ConfidenceLevel;
}

const FIXTURES: Fixture[] = [
  {
    label: "clean win — no risks, no contradictions, strong findings",
    readyDocumentCount: 6,
    findings: [
      { category: "LIABILITY", label: "Termination letter admits no just cause was cited" },
      { category: "DAMAGES", label: "Payroll records establish 4 years of continuous service" },
    ],
    openRisks: [],
    contradictions: [],
    deadlines: [{ label: "Position paper", daysUntilDue: 10 }],
    expectedBand: "FAVORABLE",
    expectedConfidence: "HIGH",
  },
  {
    label: "leans favorable — one open minor risk, otherwise supportive",
    readyDocumentCount: 5,
    findings: [
      { category: "LIABILITY", label: "Witness statement corroborates the dismissal date" },
      { category: "PROCEDURE", label: "No twin-notice compliance evidenced yet" },
    ],
    openRisks: [{ title: "Twin-notice compliance not yet documented", severity: "UNVERIFIED" }],
    contradictions: [],
    deadlines: [{ label: "Position paper", daysUntilDue: 15 }],
    expectedBand: "LEANS_FAVORABLE",
    expectedConfidence: "MEDIUM",
  },
  {
    label: "genuinely uncertain — evenly split, live contradiction",
    readyDocumentCount: 4,
    findings: [
      { category: "LIABILITY", label: "Petitioner claims verbal termination; respondent claims resignation" },
    ],
    openRisks: [{ title: "No documentary proof of either version", severity: "MAJOR" }],
    contradictions: [{ factKey: "separationType", leftValue: "Terminated", rightValue: "Resigned" }],
    deadlines: [{ label: "Position paper", daysUntilDue: 5 }],
    expectedBand: "UNCERTAIN",
    expectedConfidence: "LOW",
  },
  {
    label: "leans unfavorable — respondent's defense better documented",
    readyDocumentCount: 5,
    findings: [
      { category: "LIABILITY", label: "Company policy on the cited infraction was signed by petitioner" },
      { category: "PROCEDURE", label: "Two written notices on file, both acknowledged" },
    ],
    openRisks: [{ title: "Petitioner disputes having read the policy", severity: "MINOR" }],
    contradictions: [],
    deadlines: [],
    expectedBand: "LEANS_UNFAVORABLE",
    expectedConfidence: "MEDIUM",
  },
  {
    label: "strong loss — fatal risk, evidence undermines the claim",
    readyDocumentCount: 6,
    findings: [
      { category: "LIABILITY", label: "Video evidence corroborates the alleged misconduct" },
    ],
    openRisks: [{ title: "Petitioner's own affidavit admits the incident occurred", severity: "FATAL" }],
    contradictions: [],
    deadlines: [],
    expectedBand: "UNFAVORABLE",
    expectedConfidence: "HIGH",
  },
  {
    label: "thin evidence — only one ready document, nothing else",
    readyDocumentCount: 1,
    findings: [{ category: "LIABILITY", label: "Termination letter cites redundancy" }],
    openRisks: [],
    contradictions: [],
    deadlines: [],
    expectedBand: "UNCERTAIN",
    expectedConfidence: "LOW",
  },
  {
    label: "missing-evidence risk despite an otherwise favorable picture",
    readyDocumentCount: 5,
    findings: [{ category: "DAMAGES", label: "Claimed backpay figure matches the last three payslips on file" }],
    openRisks: [{ title: "No proof of the alleged unpaid overtime hours", severity: "MISSING_EVIDENCE" }],
    contradictions: [],
    deadlines: [{ label: "Reply", daysUntilDue: 20 }],
    expectedBand: "LEANS_FAVORABLE",
    expectedConfidence: "LOW",
  },
  {
    label: "contradiction on a peripheral fact, core claim still favorable",
    readyDocumentCount: 5,
    findings: [{ category: "LIABILITY", label: "Both parties agree the dismissal occurred without a hearing" }],
    openRisks: [],
    contradictions: [{ factKey: "employmentStartDate", leftValue: "2018-03-01", rightValue: "2018-04-15" }],
    deadlines: [],
    expectedBand: "LEANS_FAVORABLE",
    expectedConfidence: "MEDIUM",
  },
  {
    label: "balanced with a looming deadline, no other signal",
    readyDocumentCount: 3,
    findings: [{ category: "PROCEDURE", label: "Case just filed; no substantive findings yet" }],
    openRisks: [],
    contradictions: [],
    deadlines: [{ label: "Answer", daysUntilDue: 2 }],
    expectedBand: "UNCERTAIN",
    expectedConfidence: "LOW",
  },
  {
    label: "overwhelming win — many documents, deadline already met",
    readyDocumentCount: 9,
    findings: [
      { category: "LIABILITY", label: "Signed settlement offer from respondent acknowledges the debt" },
      { category: "DAMAGES", label: "Bank records confirm the exact amount owed" },
      { category: "PROCEDURE", label: "All notice requirements documented and unopposed" },
    ],
    openRisks: [],
    contradictions: [],
    deadlines: [{ label: "Position paper", daysUntilDue: 30 }],
    expectedBand: "FAVORABLE",
    expectedConfidence: "HIGH",
  },
];

/** Same rule applyOutlookGuards applies in production (case-outlook-parse.ts) — model-agnostic,
 * so whatever raw confidence Jev or chat-wonder reports, this still runs afterward in code. */
function guardedConfidence(raw: ConfidenceLevel, f: Fixture): ConfidenceLevel {
  const thin =
    f.readyDocumentCount < OUTLOOK_MIN_READY_DOCS ||
    f.openRisks.some((r) => (OUTLOOK_LOW_CONFIDENCE_RISK_SEVERITIES as readonly string[]).includes(r.severity as RiskSeverity));
  return thin ? "LOW" : raw;
}

async function main() {
  const rows: string[] = [];
  let bandCorrect = 0;
  let bandAdjacent = 0; // off by one step on the 5-point scale — a "leaning" miss, not a reversal
  let rawConfCorrect = 0;
  let guardedConfCorrect = 0;
  const latencies: number[] = [];
  const bandOrder: OutlookBand[] = ["UNFAVORABLE", "LEANS_UNFAVORABLE", "UNCERTAIN", "LEANS_FAVORABLE", "FAVORABLE"];
  const misses: string[] = [];

  for (const f of FIXTURES) {
    const start = Date.now();
    let result;
    try {
      result = await classifyOutlookWithJev(f);
    } catch (err) {
      console.error(`${f.label}: Jev call failed`, err);
      rows.push(`| ${f.label} | ${f.expectedBand} | ERROR | — | ${f.expectedConfidence} | — | — | — |`);
      continue;
    }
    const ms = Date.now() - start;
    latencies.push(ms);

    const expectedIdx = bandOrder.indexOf(f.expectedBand);
    const gotIdx = bandOrder.indexOf(result.band);
    const dist = Math.abs(expectedIdx - gotIdx);
    if (dist === 0) bandCorrect++;
    else if (dist === 1) bandAdjacent++;
    else misses.push(`${f.label}: expected ${f.expectedBand}, got ${result.band} (${Math.round(result.bandConfidence * 100)}%)`);

    const rawMatch = result.confidence === f.expectedConfidence;
    if (rawMatch) rawConfCorrect++;

    const guardedExpected = guardedConfidence(f.expectedConfidence, f);
    const guardedGot = guardedConfidence(result.confidence, f);
    if (guardedGot === guardedExpected) guardedConfCorrect++;

    rows.push(
      `| ${f.label} | ${f.expectedBand} | ${result.band} (${Math.round(result.bandConfidence * 100)}%) | ${dist === 0 ? "yes" : dist === 1 ? "adjacent" : "no"} | ${f.expectedConfidence} | ${result.confidence} (raw score ${result.confidenceScore.toFixed(2)}) | ${rawMatch ? "yes" : "no"} | ${guardedGot === guardedExpected ? "yes" : "no"} |`,
    );
    console.log(
      `${f.label}: band ${result.band} (exp ${f.expectedBand}, dist ${dist}) | confidence ${result.confidence} (exp ${f.expectedConfidence}, raw score ${result.confidenceScore.toFixed(2)}) | ${ms}ms`,
    );
  }

  const n = FIXTURES.length;
  const pct = (x: number) => `${x}/${n} (${Math.round((x / n) * 100)}%)`;
  const avgMs = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;

  const summary = [
    `# Jev case-outlook classification pilot`,
    ``,
    `Run: ${new Date().toISOString()}`,
    ``,
    `Tests classifyOutlookWithJev (band via choice, confidence via score) against 10 hand-labeled`,
    `case fact patterns spanning the full band scale and both the "thin evidence" and`,
    `"contradiction present" guard triggers. Structured signals only (findings/risks/contradictions/`,
    `deadlines) — no raw document text, unlike the current chat-wonder path. Not wired into`,
    `CaseOutlookAiSvc; this is a pre-implementation pilot only.`,
    ``,
    `| Case | Expected band | Jev band | Band match | Expected confidence | Jev confidence | Raw match | Guarded match |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- |`,
    ...rows,
    ``,
    `## Summary`,
    ``,
    `- Cases: ${n}`,
    `- Avg Jev latency: ${avgMs}ms per case (band + confidence together, one call)`,
    ``,
    `### Band (choice, 5-point scale)`,
    ``,
    `- Exact match: ${pct(bandCorrect)}`,
    `- Off by one step (e.g. FAVORABLE vs LEANS_FAVORABLE): ${pct(bandAdjacent)}`,
    `- Off by more than one step: ${pct(n - bandCorrect - bandAdjacent)}`,
    ...(misses.length ? [``, `Off by more than one step:`, ...misses.map((m) => `- ${m}`)] : []),
    ``,
    `### Confidence (score, 3-point rubric)`,
    ``,
    `- Raw match (before the code-side thin-evidence guard): ${pct(rawConfCorrect)}`,
    `- Match after applying the real applyOutlookGuards rule (OUTLOOK_MIN_READY_DOCS=${OUTLOOK_MIN_READY_DOCS}, ` +
      `${OUTLOOK_LOW_CONFIDENCE_RISK_SEVERITIES.join("/")} → LOW): ${pct(guardedConfCorrect)}`,
    ``,
    `### Reading this`,
    ``,
    `Band and confidence are asked in one Jev call over structured facts only — no rationale or`,
    `driver citations, which the outlook feature needs and Jev has no primitive for. A strong score`,
    `here means Jev is a viable **band/confidence sanity check or pre-classifier**, not a chat-wonder`,
    `replacement: the rationale-writing call would still be needed regardless of this result.`,
  ].join("\n");

  const outDir = path.resolve(__dirname, "..", "benchmarks", "jev-case-outlook");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  fs.writeFileSync(outFile, summary);
  console.log(`\n${summary.slice(summary.indexOf("## Summary"))}\n\nWritten to ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
