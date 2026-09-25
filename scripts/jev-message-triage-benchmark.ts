/**
 * Backtests triageMessage against a fixed set of hand-labeled consultation/case chat messages:
 * urgency (explicit wording, implicit dates/periods, routine controls) and intent (what the user
 * is asking for — CONSULTATION / DRAFT_DOCUMENT / DRAFT_PLEADING / ANALYZE_DOCUMENT /
 * LEGAL_RESEARCH / PARALEGAL_TASK / OTHER). Unlike the proposition/validity benchmarks, there's no
 * existing heuristic or chat-wonder path to compare against here — triage is a new capability,
 * not a replacement — so this only measures Jev against hand-labeled ground truth. One Jev call
 * per case answers both questions.
 *
 *   npx ts-node scripts/jev-message-triage-benchmark.ts
 *
 * Requires TYPESAFE_API_KEY in .env regardless of USE_JEV_MESSAGE_TRIAGE's value — this script
 * calls triageMessage directly. Writes results to
 * benchmarks/jev-message-triage/<timestamp>.md.
 */
import * as dotenv from "dotenv";
dotenv.config();
import * as fs from "fs";
import * as path from "path";
import { triageMessage, missingAttachmentContextFor, MessageIntent, INTENT_HINT_THRESHOLD, ATTACHMENT_THRESHOLD } from "../src/utils/message-triage";

interface Case {
  label: string;
  message: string;
  expected: boolean;
  /** Expected intent label — see MESSAGE_INTENTS. */
  intent: MessageIntent;
  /** Expected refersToAttachment ≥ ATTACHMENT_THRESHOLD (message depends on a document the user
   * thinks they supplied). Omitted = not scored for this case. */
  attachment?: boolean;
  /** "explicit" — the message says deadline/tonight/tomorrow/emergency outright (chat-wonder
   * needs no help there). "implicit" — urgency is only inferable from a date, a served-date plus
   * a statutory period, or a detail buried in a pasted email; the cases where triage could
   * actually tell the model something it wouldn't have noticed. */
  group: "explicit" | "implicit";
}

const CASES: Case[] = [
  // Urgent
  {
    label: "eviction, 48hr deadline",
    message:
      "Our client just received a Notice to Vacate with a 48-hour compliance deadline — the sheriff is scheduled to execute tomorrow morning. What can we file right now to stop this?",
    expected: true,
    group: "explicit",
    intent: "CONSULTATION",
    attachment: false,
  },
  {
    label: "summary judgment, due Friday",
    message: "The other party's counsel just served a motion for summary judgment and the opposition is due Friday. I haven't started drafting yet.",
    expected: true,
    group: "explicit",
    intent: "DRAFT_PLEADING",
  },
  {
    label: "client arrested, in custody now",
    message: "Client was just arrested and is being held at the police station right now, needs counsel immediately.",
    expected: true,
    group: "explicit",
    intent: "CONSULTATION",
  },
  {
    label: "hearing moved up to this afternoon",
    message: "The injunction hearing got moved up to this afternoon, we need to file our opposition in the next hour.",
    expected: true,
    group: "explicit",
    intent: "DRAFT_PLEADING",
  },
  {
    label: "emergency TRO filed against client",
    message: "Opposing party just filed an emergency motion for a TRO against my client, effective immediately.",
    expected: true,
    group: "explicit",
    intent: "CONSULTATION",
  },
  {
    label: "statute of limitations expires tonight",
    message: "Statute of limitations on this claim expires at midnight tonight.",
    expected: true,
    group: "explicit",
    intent: "CONSULTATION",
  },
  {
    label: "visa expires in two days",
    message: "Client's visa expires in two days and immigration is asking for additional documents.",
    expected: true,
    group: "explicit",
    intent: "CONSULTATION",
  },
  {
    label: "oral arguments set for tomorrow",
    message: "We just got notified the appellate court set oral arguments for tomorrow morning.",
    expected: true,
    group: "explicit",
    intent: "CONSULTATION",
  },
  // Not urgent
  {
    label: "general annulment question",
    message: "Can you explain the general requirements for annulment under Philippine law?",
    expected: false,
    group: "explicit",
    intent: "LEGAL_RESEARCH",
  },
  {
    label: "general employment tribunal question",
    message: "What's the usual process for an unfair dismissal claim at an employment tribunal?",
    expected: false,
    group: "explicit",
    intent: "LEGAL_RESEARCH",
  },
  {
    label: "casual discovery status check-in",
    message: "Just wanted to check in on the status of the discovery documents whenever you get a chance.",
    expected: false,
    group: "explicit",
    intent: "OTHER",
  },
  {
    label: "no-rush document review",
    message: "Could you review this draft NDA sometime this week, no rush.",
    expected: false,
    group: "explicit",
    intent: "ANALYZE_DOCUMENT",
    attachment: true,
  },
  {
    label: "training materials request",
    message: "I'm putting together training materials on contract law basics for junior associates.",
    expected: false,
    group: "explicit",
    intent: "PARALEGAL_TASK",
  },
  {
    label: "general small claims question (UK)",
    message: "What are the typical stages of a small claims case in the UK?",
    expected: false,
    group: "explicit",
    intent: "LEGAL_RESEARCH",
  },
  {
    label: "follow-up for records",
    message: "Following up on last month's consultation notes for my records.",
    expected: false,
    group: "explicit",
    intent: "OTHER",
  },
  {
    label: "general negligence question (UK)",
    message: "Can you summarize the key elements of negligence under UK tort law?",
    expected: false,
    group: "explicit",
    intent: "LEGAL_RESEARCH",
    attachment: false,
  },
  // --- implicit urgency: no "deadline"/"urgent"/"tonight" wording ---
  {
    label: "implicit: served date + 15-day answer period (PH)",
    message: "We received the summons and complaint on September 8. The client only brought it to me today, the 21st. What do we do about the answer?",
    expected: true,
    group: "implicit",
    intent: "CONSULTATION",
  },
  {
    label: "implicit: hearing date two days out, stated as a date",
    message: "The pre-trial is set for September 23 and the client hasn't given us the pre-trial brief materials yet. Thoughts on how to handle this?",
    expected: true,
    group: "implicit",
    intent: "CONSULTATION",
  },
  {
    label: "implicit: appeal period from a decision date (PH)",
    message: "Client received the RTC decision on September 7. They're asking whether an appeal is worth it. Can you outline the considerations?",
    expected: true,
    group: "implicit",
    intent: "CONSULTATION",
  },
  {
    label: "implicit: buried in pasted client email",
    message: "Forwarding what the client sent — 'Hi, hope you're well. Attached are the photos from the site visit like you asked. Also the bank sent a letter saying they'll foreclose if the arrears aren't settled by Wednesday but I think that's a bluff. Anyway let me know about the photos.' Can you look at the photos issue?",
    expected: true,
    group: "implicit",
    intent: "ANALYZE_DOCUMENT",
    attachment: true,
  },
  {
    label: "implicit: UK employment tribunal limitation from dismissal date",
    message: "The employee was dismissed on 25 June 2026 and has just come to us about unfair dismissal. ACAS early conciliation hasn't been started. What are the merits?",
    expected: true,
    group: "implicit",
    intent: "CONSULTATION",
  },
  {
    label: "implicit: UK possession order, bailiff date as a date",
    message: "The county court made a possession order and the bailiff's appointment is listed for 23 September. The tenant wants to know about applying to suspend the warrant.",
    expected: true,
    group: "implicit",
    intent: "CONSULTATION",
  },
  // --- implicit routine: dates present but nothing time-critical ---
  {
    label: "implicit routine: past date, closed matter",
    message: "The decision in this case came out on March 3, 2024 and became final months ago. I'd like a summary of the court's reasoning for a client newsletter.",
    expected: false,
    group: "implicit",
    intent: "PARALEGAL_TASK",
  },
  {
    label: "implicit routine: far-future date",
    message: "We're planning a CLE session for our associates on November 30 on the new rules on evidence. Can you draft an outline?",
    expected: false,
    group: "implicit",
    intent: "PARALEGAL_TASK",
  },
  {
    label: "implicit routine: date in a citation, not a deadline",
    message: "In the case decided on 15 August 2019 about implied easements, what test did the court apply?",
    expected: false,
    group: "implicit",
    intent: "LEGAL_RESEARCH",
  },
  {
    label: "implicit routine: pasted email with no deadline",
    message: "Client wrote: 'Thanks for the meeting on Tuesday. I've been thinking about whether to update my will at some point this year — no rush. Can we chat sometime about what changing the executor involves?' What should I prepare?",
    expected: false,
    group: "implicit",
    intent: "CONSULTATION",
    attachment: false,
  },
  // --- intent cases: routine urgency, one label each ---
  {
    label: "intent: draft a lease agreement",
    message: "Please draft a residential lease agreement for a 2-bedroom condo in Makati, 12 months, PHP 45,000/month, two months deposit, one month advance, no pets.",
    expected: false,
    group: "explicit",
    intent: "DRAFT_DOCUMENT",
    attachment: false,
  },
  {
    label: "intent: demand letter",
    message: "Write a demand letter to a supplier who has failed to deliver goods worth PHP 1.2M under a purchase order dated 3 June 2026, giving them 10 days to deliver or refund.",
    expected: false,
    group: "explicit",
    intent: "DRAFT_DOCUMENT",
  },
  {
    label: "intent: answer to a complaint",
    message: "Prepare an Answer with affirmative defenses to a complaint for collection of sum of money — we deny the debt and raise prescription and lack of jurisdiction.",
    expected: false,
    group: "explicit",
    intent: "DRAFT_PLEADING",
  },
  {
    label: "intent: motion to dismiss (UK: application to strike out)",
    message: "Draft an application to strike out the claim under CPR 3.4(2)(a) on the basis that the particulars disclose no reasonable grounds.",
    expected: false,
    group: "explicit",
    intent: "DRAFT_PLEADING",
  },
  {
    label: "intent: review attached contract",
    message: "I've uploaded the shareholders' agreement. Can you go through it and flag anything unfavourable to the minority shareholder?",
    expected: false,
    group: "explicit",
    intent: "ANALYZE_DOCUMENT",
    attachment: true,
  },
  {
    label: "intent: summarise a judgment (attached)",
    message: "Here's the Court of Appeals decision (attached). Summarise the ruling and the ratio in plain terms for the client.",
    expected: false,
    group: "explicit",
    intent: "ANALYZE_DOCUMENT",
    attachment: true,
  },
  {
    label: "intent: find authorities",
    message: "What are the leading Philippine Supreme Court cases on psychological incapacity after Tan-Andal?",
    expected: false,
    group: "explicit",
    intent: "LEGAL_RESEARCH",
    attachment: false,
  },
  {
    label: "intent: what does the statute say",
    message: "What does section 43B of the Employment Rights Act 1996 define as a qualifying disclosure?",
    expected: false,
    group: "explicit",
    intent: "LEGAL_RESEARCH",
  },
  {
    label: "intent: chronology from the case file",
    message: "Build a chronology of events from the case documents, with dates and the source document for each entry.",
    expected: false,
    group: "explicit",
    intent: "PARALEGAL_TASK",
  },
  {
    label: "intent: deadline calendar",
    message: "Give me a checklist of the filing deadlines for this appeal counted from the date of receipt of the decision, in a table.",
    expected: false,
    group: "explicit",
    intent: "PARALEGAL_TASK",
  },
  {
    label: "intent: greeting",
    message: "hi, are you there?",
    expected: false,
    group: "explicit",
    intent: "OTHER",
    attachment: false,
  },
  {
    label: "intent: test message",
    message: "test",
    expected: false,
    group: "explicit",
    intent: "OTHER",
  },
  // --- deadline computation ---
  {
    label: "deadline: answer from service date (PH)",
    message: "Summons was served on September 8, 2026. When is the last day to file the Answer?",
    expected: true,
    group: "implicit",
    intent: "DEADLINE_COMPUTATION",
    attachment: false,
  },
  {
    label: "deadline: appeal from receipt of decision (PH)",
    message: "We received the RTC decision on September 7. Count the period for a notice of appeal for me — when exactly does it lapse?",
    expected: true,
    group: "implicit",
    intent: "DEADLINE_COMPUTATION",
    attachment: false,
  },
  {
    label: "deadline: how is the period counted",
    message: "If the 15-day period ends on a Saturday, does it move to Monday? How are the days counted under the Rules?",
    expected: false,
    group: "explicit",
    intent: "DEADLINE_COMPUTATION",
    attachment: false,
  },
  {
    label: "deadline: UK ET limitation from dismissal",
    message: "Dismissal was effective 25 June 2026 and ACAS early conciliation ran from 10 to 24 July. What's the last day to present the ET1?",
    expected: true,
    group: "implicit",
    intent: "DEADLINE_COMPUTATION",
    attachment: false,
  },
  {
    label: "deadline: defence after acknowledgment (UK)",
    message: "Particulars of claim deemed served 1 September, acknowledgment of service filed. By what date must the defence be filed under CPR 15.4?",
    expected: true,
    group: "implicit",
    intent: "DEADLINE_COMPUTATION",
    attachment: false,
  },
  // --- revise previous ---
  {
    label: "revise: shorten",
    message: "That's too long — cut it down to one page and keep only the three strongest arguments.",
    expected: false,
    group: "explicit",
    intent: "REVISE_PREVIOUS",
    attachment: false,
  },
  {
    label: "revise: add a clause",
    message: "Add a non-compete clause for 12 months within Metro Manila and change the governing law to Philippine law.",
    expected: false,
    group: "explicit",
    intent: "REVISE_PREVIOUS",
    attachment: false,
  },
  {
    label: "revise: translate",
    message: "Can you redo the demand letter in Tagalog? Keep the same tone.",
    expected: false,
    group: "explicit",
    intent: "REVISE_PREVIOUS",
    attachment: false,
  },
  {
    label: "revise: fix a name",
    message: "You used the wrong respondent — it should be Meridian Structures Ltd, not Meridian Holdings. Please correct it throughout.",
    expected: false,
    group: "explicit",
    intent: "REVISE_PREVIOUS",
    attachment: false,
  },
  {
    label: "revise: reformat",
    message: "Put that chronology into a table with columns for date, event, and source document.",
    expected: false,
    group: "explicit",
    intent: "REVISE_PREVIOUS",
    attachment: false,
  },
  // --- attachment-dependent messages with nothing attached (the guard's target) ---
  {
    label: "attachment: 'see attached' with no attachment",
    message: "See attached lease. Is the early termination clause enforceable?",
    expected: false,
    group: "explicit",
    intent: "ANALYZE_DOCUMENT",
    attachment: true,
  },
  {
    label: "attachment: refers to an email the assistant never saw",
    message: "Based on the email opposing counsel sent us yesterday, do we need to respond before the hearing?",
    expected: true,
    group: "implicit",
    intent: "CONSULTATION",
    attachment: true,
  },
];

async function main() {
  const rows: string[] = [];
  let correct = 0;
  const urgentProbs: number[] = [];
  const routineProbs: number[] = [];

  const byGroup: Record<Case["group"], { n: number; correct: number }> = { explicit: { n: 0, correct: 0 }, implicit: { n: 0, correct: 0 } };
  let intentCorrect = 0;
  let intentHintable = 0;
  let attachScored = 0;
  let attachCorrect = 0;
  const attachConfusions: string[] = [];
  const intentConfusions: string[] = [];
  const byIntent: Record<string, { n: number; correct: number }> = {};
  for (const c of CASES) {
    const start = Date.now();
    const result = await triageMessage(c.message);
    const ms = Date.now() - start;
    const got = result?.urgent ?? null;
    const prob = result?.probability ?? null;
    const gotIntent = result?.intent ?? null;
    const intentConf = result?.intentConfidence ?? null;
    byIntent[c.intent] = byIntent[c.intent] ?? { n: 0, correct: 0 };
    byIntent[c.intent].n++;
    if (gotIntent === c.intent) {
      intentCorrect++;
      byIntent[c.intent].correct++;
    } else {
      intentConfusions.push(`${c.label}: expected ${c.intent}, got ${gotIntent} (${intentConf !== null ? Math.round(intentConf * 100) : "?"}%)`);
    }
    if (intentConf !== null && intentConf >= INTENT_HINT_THRESHOLD) intentHintable++;
    const attachP = result?.refersToAttachment ?? null;
    if (c.attachment !== undefined && attachP !== null) {
      attachScored++;
      // Score what the guard actually does (threshold + the REVISE_PREVIOUS exclusion), assuming
      // nothing is attached — that's the only situation in which it can fire.
      const gotAttach = result !== null && missingAttachmentContextFor(result, false) !== "";
      if (gotAttach === c.attachment) attachCorrect++;
      else attachConfusions.push(`${c.label}: expected ${c.attachment ? "depends on attachment" : "no attachment"}, got ${Math.round(attachP * 100)}%`);
    }

    byGroup[c.group].n++;
    if (got === c.expected) {
      correct++;
      byGroup[c.group].correct++;
    }
    if (prob !== null) (c.expected ? urgentProbs : routineProbs).push(prob);

    rows.push(
      `| ${c.label} | ${c.group} | ${c.expected ? "urgent" : "routine"} | ${got === null ? "null" : got ? "urgent" : "routine"} (${prob !== null ? Math.round(prob * 100) : "?"}%, ${ms}ms) | ${got === c.expected ? "yes" : "no"} | ${c.intent} | ${gotIntent ?? "null"} (${intentConf !== null ? Math.round(intentConf * 100) : "?"}%) | ${gotIntent === c.intent ? "yes" : "no"} | ${attachP !== null ? Math.round(attachP * 100) + "%" : "?"}${c.attachment !== undefined ? ` (exp ${c.attachment ? "yes" : "no"})` : ""} |`,
    );
    console.log(
      `${c.label}: urgency expected=${c.expected ? "urgent" : "routine"} got=${got === null ? "null" : got ? "urgent" : "routine"} (${prob !== null ? Math.round(prob * 100) : "?"}%) | intent expected=${c.intent} got=${gotIntent} (${intentConf !== null ? Math.round(intentConf * 100) : "?"}%)`,
    );
  }

  const avg = (arr: number[]) => (arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) : null);

  const summary = [
    `# Jev message triage benchmark — urgency + intent`,
    ``,
    `Run: ${new Date().toISOString()}`,
    ``,
    `No prior baseline exists for this — urgency triage is a new capability (see benchmarks/jev-report-2026-09-21.md),`,
    `not a replacement for an existing heuristic or chat-wonder path. This only checks Jev against`,
    `hand-labeled expected values.`,
    ``,
    `| Case | Group | Expected urgency | Jev urgency | Correct | Expected intent | Jev intent | Correct | Attachment |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
    ...rows,
    ``,
    `## Summary`,
    ``,
    `- Cases: ${CASES.length} (${CASES.filter((c) => c.expected).length} urgent, ${CASES.filter((c) => !c.expected).length} routine)`,
    `- Accuracy: ${correct}/${CASES.length} (${Math.round((correct / CASES.length) * 100)}%)`,
    `- Explicit wording: ${byGroup.explicit.correct}/${byGroup.explicit.n}`,
    `- Implicit (date/period only): ${byGroup.implicit.correct}/${byGroup.implicit.n}`,
    `- Avg probability on urgent cases: ${avg(urgentProbs)}%`,
    `- Avg probability on routine cases: ${avg(routineProbs)}%`,
    ``,
    `## Intent`,
    ``,
    `- Accuracy: ${intentCorrect}/${CASES.length} (${Math.round((intentCorrect / CASES.length) * 100)}%)`,
    `- Cases at or above INTENT_HINT_THRESHOLD (${INTENT_HINT_THRESHOLD}) — i.e. would inject a hint: ${intentHintable}/${CASES.length}`,
    ...Object.entries(byIntent)
      .sort()
      .map(([k, v]) => `- ${k}: ${v.correct}/${v.n}`),
    ...(intentConfusions.length ? [``, `Misclassified:`, ...intentConfusions.map((x) => `- ${x}`)] : []),
    ``,
    `## Missing-attachment guard (refersToAttachment ≥ ${ATTACHMENT_THRESHOLD}, never on REVISE_PREVIOUS; scored as if nothing were attached)`,
    ``,
    `- Guard fires when expected: ${attachCorrect}/${attachScored}`,
    ...(attachConfusions.length ? [``, `Misclassified:`, ...attachConfusions.map((x) => `- ${x}`)] : []),
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
