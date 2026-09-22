/**
 * Compares classifyPropositionWithChatWonder vs classifyPropositionWithJev on a fixed set of
 * quote/official-text pairs (a handful of hand-written cases plus any real CitationCheck rows
 * that already have officialText + propositionType), timing each call and checking whether the
 * two paths agree.
 *
 *   npx ts-node scripts/jev-proposition-benchmark.ts
 *
 * Requires TYPESAFE_API_KEY in .env regardless of USE_JEV_PROPOSITION's value — this script
 * calls both paths directly, not through the flag. Writes results to
 * benchmarks/jev-citation-proposition/<timestamp>.md.
 */
import * as dotenv from "dotenv";
dotenv.config();
import * as fs from "fs";
import * as path from "path";
import prisma from "../src/lib/prisma";
import CaseAccess from "../src/utils/case-access";
import { classifyPropositionWithChatWonder, classifyPropositionWithJev } from "../src/utils/citation-proposition";
import { TenantCode } from "../src/types/tenant-code";

interface Case {
  label: string;
  quotedText: string;
  officialText: string;
  tenantCode: TenantCode;
  expected?: "PARAPHRASED" | "INFERRED";
}

const HAND_WRITTEN: Case[] = [
  {
    label: "clear paraphrase (damages clause)",
    officialText:
      "The respondent shall pay the petitioner the amount of PHP 500,000.00 as moral damages within thirty (30) days from the finality of this judgment.",
    quotedText:
      "The court ordered the respondent to settle PHP 500,000 in moral damages to the petitioner within a month of the ruling becoming final.",
    tenantCode: "PH",
    expected: "PARAPHRASED",
  },
  {
    label: "clear inference (liability not stated)",
    officialText:
      "The respondent shall pay the petitioner the amount of PHP 500,000.00 as moral damages within thirty (30) days from the finality of this judgment.",
    quotedText: "The court found the respondent liable for damages.",
    tenantCode: "PH",
    expected: "INFERRED",
  },
  {
    label: "subtle paraphrase (UK negligence standard)",
    officialText:
      "A duty of care arises where harm to the claimant was reasonably foreseeable, there was sufficient proximity between the parties, and it is fair, just and reasonable to impose a duty.",
    quotedText:
      "Caparo established that a duty of care requires foreseeability of harm, proximity, and that imposing the duty be fair and reasonable.",
    tenantCode: "UK",
    expected: "PARAPHRASED",
  },
  {
    label: "borderline inference (implied intent)",
    officialText:
      "The defendant sent the email at 11:58pm, two minutes before the contractual deadline, and included only a signed cover page without the required attachments.",
    quotedText: "The defendant intended to miss the deadline.",
    tenantCode: "UK",
    expected: "INFERRED",
  },
  {
    label: "paraphrase (PH contract breach)",
    officialText:
      "The Seller failed to deliver the goods within the fifteen (15)-day period stipulated in Clause 4.2, thereby constituting a material breach of contract.",
    quotedText: "The Seller's failure to deliver within the fifteen-day window under Clause 4.2 was a material breach.",
    tenantCode: "PH",
    expected: "PARAPHRASED",
  },
  {
    label: "inference (remedy not stated)",
    officialText:
      "The Seller failed to deliver the goods within the fifteen (15)-day period stipulated in Clause 4.2, thereby constituting a material breach of contract.",
    quotedText: "The Buyer is entitled to rescind the contract.",
    tenantCode: "PH",
    expected: "INFERRED",
  },
  {
    label: "paraphrase (PH bail standard)",
    officialText:
      "Bail shall not be a matter of right in offenses punishable by reclusion perpetua when the evidence of guilt is strong.",
    quotedText:
      "In offenses carrying a reclusion perpetua penalty, bail is discretionary rather than a matter of right if the evidence of guilt is strong.",
    tenantCode: "PH",
    expected: "PARAPHRASED",
  },
  {
    label: "inference (custody outcome not stated)",
    officialText: "The accused should remain in custody until trial.",
    quotedText: "The accused is guilty of the offense charged.",
    tenantCode: "PH",
    expected: "INFERRED",
  },
  {
    label: "paraphrase (UK unfair dismissal)",
    officialText:
      "An employee is regarded as unfairly dismissed if the employer fails to follow a fair procedure, even where a valid reason for dismissal exists.",
    quotedText:
      "Dismissal will be unfair where the employer does not follow fair procedure, regardless of whether there was a valid reason.",
    tenantCode: "UK",
    expected: "PARAPHRASED",
  },
  {
    label: "inference (remedy not stated, UK dismissal)",
    officialText:
      "An employee is regarded as unfairly dismissed if the employer fails to follow a fair procedure, even where a valid reason for dismissal exists.",
    quotedText: "The employee should be reinstated.",
    tenantCode: "UK",
    expected: "INFERRED",
  },
  {
    label: "paraphrase (PH child custody)",
    officialText:
      "The custody of children below seven years of age shall be given to the mother, unless the court finds compelling reasons to order otherwise.",
    quotedText:
      "Mothers are generally awarded custody of children under seven, absent compelling reasons for the court to decide differently.",
    tenantCode: "PH",
    expected: "PARAPHRASED",
  },
  {
    label: "inference (overstated absolute rule)",
    officialText:
      "The custody of children below seven years of age shall be given to the mother, unless the court finds compelling reasons to order otherwise.",
    quotedText: "Fathers cannot obtain custody of young children under any circumstance.",
    tenantCode: "PH",
    expected: "INFERRED",
  },
  {
    label: "paraphrase (PH land sale formalities)",
    officialText:
      "A contract of sale of a parcel of land, to be valid and enforceable, must be in a public instrument and registered with the Registry of Deeds.",
    quotedText:
      "For a land sale contract to be valid and enforceable, it must be executed as a public instrument and duly registered.",
    tenantCode: "PH",
    expected: "PARAPHRASED",
  },
  {
    label: "inference (voidness not stated)",
    officialText:
      "A contract of sale of a parcel of land, to be valid and enforceable, must be in a public instrument and registered with the Registry of Deeds.",
    quotedText: "Unregistered land sales are automatically void from the start.",
    tenantCode: "PH",
    expected: "INFERRED",
  },
  {
    label: "paraphrase (UK res ipsa loquitur elements)",
    officialText:
      "Res ipsa loquitur applies where the injury would not ordinarily occur absent negligence, the instrumentality was under the defendant's exclusive control, and the plaintiff did not contribute to the injury.",
    quotedText:
      "The doctrine applies when three elements are met: the accident wouldn't normally happen without negligence, the defendant had sole control of the cause, and the plaintiff wasn't at fault.",
    tenantCode: "UK",
    expected: "PARAPHRASED",
  },
  {
    label: "inference (automatic liability overstated)",
    officialText:
      "Res ipsa loquitur applies where the injury would not ordinarily occur absent negligence, the instrumentality was under the defendant's exclusive control, and the plaintiff did not contribute to the injury.",
    quotedText: "The defendant is automatically liable whenever res ipsa loquitur applies.",
    tenantCode: "UK",
    expected: "INFERRED",
  },
];

async function realCases(): Promise<Case[]> {
  const rows = await prisma.citationCheck.findMany({
    where: { propositionType: { not: null }, officialText: { not: null } },
    select: { caseId: true, quotedText: true, officialText: true, propositionType: true },
  });
  const out: Case[] = [];
  for (const row of rows) {
    if (row.propositionType !== "PARAPHRASED" && row.propositionType !== "INFERRED") continue;
    const tenantCode = await CaseAccess.resolveTenantCode(row.caseId).catch(() => "PH" as TenantCode);
    out.push({
      label: `real CitationCheck row (case ${row.caseId.slice(0, 8)})`,
      quotedText: row.quotedText,
      officialText: row.officialText!,
      tenantCode,
      expected: row.propositionType,
    });
  }
  return out;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; result: T | null; error?: string }> {
  const start = Date.now();
  try {
    const result = await fn();
    return { ms: Date.now() - start, result };
  } catch (err) {
    return { ms: Date.now() - start, result: null, error: err instanceof Error ? err.message : String(err) };
  }
}

async function main() {
  const cases = [...HAND_WRITTEN, ...(await realCases())];
  const rows: string[] = [];
  let cwCorrect = 0;
  let jevCorrect = 0;
  let agree = 0;
  let scored = 0;
  const cwLatencies: number[] = [];
  const jevLatencies: number[] = [];

  for (const c of cases) {
    const cw = await timed(() => classifyPropositionWithChatWonder(c.quotedText, c.officialText, c.tenantCode));
    const jev = await timed(() => classifyPropositionWithJev(c.quotedText, c.officialText));
    cwLatencies.push(cw.ms);
    jevLatencies.push(jev.ms);

    const cwType = cw.result?.type ?? cw.error ?? "null";
    const jevType = jev.result?.type ?? jev.error ?? "null";
    if (c.expected) {
      scored++;
      if (cwType === c.expected) cwCorrect++;
      if (jevType === c.expected) jevCorrect++;
    }
    if (cwType === jevType) agree++;

    rows.push(
      `| ${c.label} | ${c.expected ?? "—"} | ${cwType} (${cw.ms}ms) | ${jevType} (${jev.ms}ms) | ${cwType === jevType ? "yes" : "no"} |`,
    );
    console.log(`${c.label}: chat-wonder=${cwType} (${cw.ms}ms)  jev=${jevType} (${jev.ms}ms)`);
  }

  const avg = (arr: number[]) => Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
  const summary = [
    `# Jev vs chat-wonder — citation proposition classification`,
    ``,
    `Run: ${new Date().toISOString()}`,
    ``,
    `| Case | Expected | chat-wonder | Jev | Agree |`,
    `| --- | --- | --- | --- | --- |`,
    ...rows,
    ``,
    `## Summary`,
    ``,
    `- Cases: ${cases.length} (${scored} with a known expected label)`,
    `- chat-wonder accuracy: ${scored ? `${cwCorrect}/${scored} (${Math.round((cwCorrect / scored) * 100)}%)` : "n/a"}`,
    `- Jev accuracy: ${scored ? `${jevCorrect}/${scored} (${Math.round((jevCorrect / scored) * 100)}%)` : "n/a"}`,
    `- Agreement between the two: ${agree}/${cases.length} (${Math.round((agree / cases.length) * 100)}%)`,
    `- Avg latency — chat-wonder: ${avg(cwLatencies)}ms, Jev: ${avg(jevLatencies)}ms`,
  ].join("\n");

  const outDir = path.resolve(__dirname, "..", "benchmarks", "jev-citation-proposition");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  fs.writeFileSync(outFile, summary);
  console.log(`\n${summary}\n\nWritten to ${outFile}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
