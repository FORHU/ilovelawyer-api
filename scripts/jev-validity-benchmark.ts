/**
 * Compares evaluateCitationHeuristic vs evaluateCitationWithJev on a fixed set of quote/official
 * pairs that all have no normalized textual match (containsQuote false) — the case where the old
 * heuristic always defaults to INVALID. Checks whether Jev correctly distinguishes VALID
 * (paraphrased-but-accurate), INVALID (genuinely fabricated), and ADVERSE (contradicts the
 * source) instead.
 *
 *   npx ts-node scripts/jev-validity-benchmark.ts
 *
 * Requires TYPESAFE_API_KEY in .env regardless of USE_JEV_VALIDITY's value — this script calls
 * both paths directly, not through the flag. Writes results to
 * benchmarks/jev-citation-validity/<timestamp>.md.
 */
import * as dotenv from "dotenv";
dotenv.config();
import * as fs from "fs";
import * as path from "path";
import { evaluateCitationHeuristic, evaluateCitationWithJev } from "../src/utils/citation-validity";

interface Case {
  label: string;
  quotedText: string;
  officialText: string;
  expected: "VALID" | "INVALID" | "ADVERSE";
}

const CASES: Case[] = [
  // VALID — heavily paraphrased but actually supported; the heuristic's 85% word-overlap match
  // has no way to see this and always calls it INVALID.
  {
    label: "valid paraphrase (contract breach)",
    officialText:
      "The Seller failed to deliver the goods within the fifteen (15)-day period stipulated in Clause 4.2, thereby constituting a material breach of contract.",
    quotedText: "The Seller's late delivery beyond the contractual fifteen-day period was a material breach.",
    expected: "VALID",
  },
  {
    label: "valid paraphrase (UK negligence standard)",
    officialText:
      "A duty of care arises where harm to the claimant was reasonably foreseeable, there was sufficient proximity between the parties, and it is fair, just and reasonable to impose a duty.",
    quotedText:
      "Caparo established that a duty of care requires foreseeability of harm, proximity, and that imposing the duty be fair and reasonable.",
    expected: "VALID",
  },
  {
    label: "valid paraphrase (PH bail standard)",
    officialText:
      "Bail shall not be a matter of right in offenses punishable by reclusion perpetua when the evidence of guilt is strong.",
    quotedText: "Bail is not a matter of right for offenses punishable by reclusion perpetua if evidence of guilt is strong.",
    expected: "VALID",
  },
  {
    label: "valid paraphrase (PH land sale formalities)",
    officialText:
      "A contract of sale of a parcel of land, to be valid and enforceable, must be in a public instrument and registered with the Registry of Deeds.",
    quotedText: "Land sale contracts must be registered and executed publicly to be valid.",
    expected: "VALID",
  },
  {
    label: "valid paraphrase (PH child custody)",
    officialText:
      "The custody of children below seven years of age shall be given to the mother, unless the court finds compelling reasons to order otherwise.",
    quotedText: "Custody of kids younger than seven usually goes to the mother unless there's good reason not to.",
    expected: "VALID",
  },
  // INVALID — genuinely fabricated or unrelated to the source.
  {
    label: "invalid (fabricated win-rate claim)",
    officialText: "No person shall be deprived of life, liberty, or property without due process of law.",
    quotedText: "Lawyers are entitled to a ninety percent win rate under this ruling.",
    expected: "INVALID",
  },
  {
    label: "invalid (unrelated notarization claim)",
    officialText:
      "A contract of sale of a parcel of land, to be valid and enforceable, must be in a public instrument and registered with the Registry of Deeds.",
    quotedText: "All contracts must be notarized in the presence of the Supreme Court.",
    expected: "INVALID",
  },
  {
    label: "invalid (unrelated employer obligation)",
    officialText:
      "A duty of care arises where harm to the claimant was reasonably foreseeable, there was sufficient proximity between the parties, and it is fair, just and reasonable to impose a duty.",
    quotedText: "Employers must provide free lunch to all employees.",
    expected: "INVALID",
  },
  {
    label: "invalid (fabricated penalty claim)",
    officialText:
      "Bail shall not be a matter of right in offenses punishable by reclusion perpetua when the evidence of guilt is strong.",
    quotedText: "The death penalty applies automatically to all reclusion perpetua offenses.",
    expected: "INVALID",
  },
  {
    label: "invalid (fabricated damages claim)",
    officialText:
      "Res ipsa loquitur applies where the injury would not ordinarily occur absent negligence, the instrumentality was under the defendant's exclusive control, and the plaintiff did not contribute to the injury.",
    quotedText: "Punitive damages are mandatory whenever res ipsa loquitur applies.",
    expected: "INVALID",
  },
  // ADVERSE — official text states the opposite outcome; the old heuristic has no status for this.
  {
    label: "adverse (liability reversed)",
    officialText: "The court held that the respondent is jointly and severally liable for the damages claimed.",
    quotedText: "The court held that the respondent bears no liability for the damages claimed.",
    expected: "ADVERSE",
  },
  {
    label: "adverse (dismissal outcome reversed)",
    officialText:
      "The employee was found to have followed proper procedure prior to dismissal, and the dismissal was held to be fair.",
    quotedText: "The tribunal found the dismissal procedurally unfair.",
    expected: "ADVERSE",
  },
  {
    label: "adverse (land sale validity reversed)",
    officialText: "The land sale was declared valid as it was executed in a public instrument and duly registered.",
    quotedText: "The court declared the land sale void for lack of registration.",
    expected: "ADVERSE",
  },
  {
    label: "adverse (custody outcome reversed)",
    officialText: "The custody of the child was awarded to the father after the court found compelling reasons against maternal custody.",
    quotedText: "The court awarded custody to the mother as the default rule.",
    expected: "ADVERSE",
  },
  {
    label: "adverse (verdict reversed)",
    officialText: "The defendant was acquitted as the evidence of guilt was found to be weak.",
    quotedText: "The defendant was convicted based on strong evidence of guilt.",
    expected: "ADVERSE",
  },
];

async function timed<T>(fn: () => Promise<T> | T): Promise<{ ms: number; result: T | null; error?: string }> {
  const start = Date.now();
  try {
    const result = await fn();
    return { ms: Date.now() - start, result };
  } catch (err) {
    return { ms: Date.now() - start, result: null, error: err instanceof Error ? err.message : String(err) };
  }
}

async function main() {
  const rows: string[] = [];
  let heuristicCorrect = 0;
  let jevCorrect = 0;
  let agree = 0;
  const jevLatencies: number[] = [];
  const byType: Record<string, { total: number; correct: number }> = {};

  for (const c of CASES) {
    const heuristic = await timed(() => evaluateCitationHeuristic({ quotedText: c.quotedText, officialText: c.officialText }));
    const jev = await timed(() => evaluateCitationWithJev(c.quotedText, c.officialText));
    jevLatencies.push(jev.ms);

    const hStatus = heuristic.result?.status ?? heuristic.error ?? "null";
    const jStatus = jev.result?.status ?? jev.error ?? "null";

    if (hStatus === c.expected) heuristicCorrect++;
    if (jStatus === c.expected) jevCorrect++;
    if (hStatus === jStatus) agree++;

    byType[c.expected] ??= { total: 0, correct: 0 };
    byType[c.expected].total++;
    if (jStatus === c.expected) byType[c.expected].correct++;

    rows.push(`| ${c.label} | ${c.expected} | ${hStatus} | ${jStatus} (${jev.ms}ms) | ${hStatus === jStatus ? "yes" : "no"} |`);
    console.log(`${c.label}: heuristic=${hStatus}  jev=${jStatus} (${jev.ms}ms)  expected=${c.expected}`);
  }

  const avg = (arr: number[]) => Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
  const byTypeLines = Object.entries(byType).map(
    ([type, { total, correct }]) => `- ${type}: ${correct}/${total} (${Math.round((correct / total) * 100)}%)`,
  );

  const summary = [
    `# Jev vs heuristic — citation validity classification`,
    ``,
    `Run: ${new Date().toISOString()}`,
    ``,
    `All cases have no normalized textual match, so the heuristic always defaults to INVALID — this`,
    `set exists specifically to probe that blind spot.`,
    ``,
    `| Case | Expected | Heuristic | Jev | Agree |`,
    `| --- | --- | --- | --- | --- |`,
    ...rows,
    ``,
    `## Summary`,
    ``,
    `- Cases: ${CASES.length}`,
    `- Heuristic accuracy: ${heuristicCorrect}/${CASES.length} (${Math.round((heuristicCorrect / CASES.length) * 100)}%)`,
    `- Jev accuracy: ${jevCorrect}/${CASES.length} (${Math.round((jevCorrect / CASES.length) * 100)}%)`,
    `- Jev accuracy by expected status:`,
    ...byTypeLines,
    `- Agreement between the two: ${agree}/${CASES.length} (${Math.round((agree / CASES.length) * 100)}%)`,
    `- Avg Jev latency: ${avg(jevLatencies)}ms (heuristic is synchronous, effectively 0ms)`,
  ].join("\n");

  const outDir = path.resolve(__dirname, "..", "benchmarks", "jev-citation-validity");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  fs.writeFileSync(outFile, summary);
  console.log(`\n${summary}\n\nWritten to ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
