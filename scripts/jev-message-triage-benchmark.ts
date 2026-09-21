/**
 * Backtests flagMessageUrgency against a fixed set of hand-labeled consultation/case chat
 * messages (8 urgent, 8 not) and checks accuracy against the expected label. Unlike the
 * proposition/validity benchmarks, there's no existing heuristic or chat-wonder path to compare
 * against here — urgency triage is a new capability, not a replacement — so this only measures
 * Jev against hand-labeled ground truth.
 *
 *   npx ts-node scripts/jev-message-triage-benchmark.ts
 *
 * Requires TYPESAFE_API_KEY in .env regardless of USE_JEV_MESSAGE_TRIAGE's value — this script
 * calls flagMessageUrgency directly. Writes results to
 * benchmarks/jev-message-triage/<timestamp>.md.
 */
import * as dotenv from "dotenv";
dotenv.config();
import * as fs from "fs";
import * as path from "path";
import { flagMessageUrgency } from "../src/utils/message-triage";

interface Case {
  label: string;
  message: string;
  expected: boolean;
}

const CASES: Case[] = [
  // Urgent
  {
    label: "eviction, 48hr deadline",
    message:
      "Our client just received a Notice to Vacate with a 48-hour compliance deadline — the sheriff is scheduled to execute tomorrow morning. What can we file right now to stop this?",
    expected: true,
  },
  {
    label: "summary judgment, due Friday",
    message: "The other party's counsel just served a motion for summary judgment and the opposition is due Friday. I haven't started drafting yet.",
    expected: true,
  },
  {
    label: "client arrested, in custody now",
    message: "Client was just arrested and is being held at the police station right now, needs counsel immediately.",
    expected: true,
  },
  {
    label: "hearing moved up to this afternoon",
    message: "The injunction hearing got moved up to this afternoon, we need to file our opposition in the next hour.",
    expected: true,
  },
  {
    label: "emergency TRO filed against client",
    message: "Opposing party just filed an emergency motion for a TRO against my client, effective immediately.",
    expected: true,
  },
  {
    label: "statute of limitations expires tonight",
    message: "Statute of limitations on this claim expires at midnight tonight.",
    expected: true,
  },
  {
    label: "visa expires in two days",
    message: "Client's visa expires in two days and immigration is asking for additional documents.",
    expected: true,
  },
  {
    label: "oral arguments set for tomorrow",
    message: "We just got notified the appellate court set oral arguments for tomorrow morning.",
    expected: true,
  },
  // Not urgent
  {
    label: "general annulment question",
    message: "Can you explain the general requirements for annulment under Philippine law?",
    expected: false,
  },
  {
    label: "general employment tribunal question",
    message: "What's the usual process for an unfair dismissal claim at an employment tribunal?",
    expected: false,
  },
  {
    label: "casual discovery status check-in",
    message: "Just wanted to check in on the status of the discovery documents whenever you get a chance.",
    expected: false,
  },
  {
    label: "no-rush document review",
    message: "Could you review this draft NDA sometime this week, no rush.",
    expected: false,
  },
  {
    label: "training materials request",
    message: "I'm putting together training materials on contract law basics for junior associates.",
    expected: false,
  },
  {
    label: "general small claims question (UK)",
    message: "What are the typical stages of a small claims case in the UK?",
    expected: false,
  },
  {
    label: "follow-up for records",
    message: "Following up on last month's consultation notes for my records.",
    expected: false,
  },
  {
    label: "general negligence question (UK)",
    message: "Can you summarize the key elements of negligence under UK tort law?",
    expected: false,
  },
];

async function main() {
  const rows: string[] = [];
  let correct = 0;
  const urgentProbs: number[] = [];
  const routineProbs: number[] = [];

  for (const c of CASES) {
    const start = Date.now();
    const result = await flagMessageUrgency(c.message);
    const ms = Date.now() - start;
    const got = result?.urgent ?? null;
    const prob = result?.probability ?? null;

    if (got === c.expected) correct++;
    if (prob !== null) (c.expected ? urgentProbs : routineProbs).push(prob);

    rows.push(
      `| ${c.label} | ${c.expected ? "urgent" : "routine"} | ${got === null ? "null" : got ? "urgent" : "routine"} (${prob !== null ? Math.round(prob * 100) : "?"}%, ${ms}ms) | ${got === c.expected ? "yes" : "no"} |`,
    );
    console.log(`${c.label}: expected=${c.expected ? "urgent" : "routine"} got=${got === null ? "null" : got ? "urgent" : "routine"} (${prob !== null ? Math.round(prob * 100) : "?"}%)`);
  }

  const avg = (arr: number[]) => (arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) : null);

  const summary = [
    `# Jev message urgency triage benchmark`,
    ``,
    `Run: ${new Date().toISOString()}`,
    ``,
    `No prior baseline exists for this — urgency triage is a new capability (see the Jev integration doc),`,
    `not a replacement for an existing heuristic or chat-wonder path. This only checks Jev against`,
    `hand-labeled expected values.`,
    ``,
    `| Case | Expected | Jev | Correct |`,
    `| --- | --- | --- | --- |`,
    ...rows,
    ``,
    `## Summary`,
    ``,
    `- Cases: ${CASES.length} (8 urgent, 8 routine)`,
    `- Accuracy: ${correct}/${CASES.length} (${Math.round((correct / CASES.length) * 100)}%)`,
    `- Avg probability on urgent cases: ${avg(urgentProbs)}%`,
    `- Avg probability on routine cases: ${avg(routineProbs)}%`,
  ].join("\n");

  const outDir = path.resolve(__dirname, "..", "benchmarks", "jev-message-triage");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  fs.writeFileSync(outFile, summary);
  console.log(`\n${summary}\n\nWritten to ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
