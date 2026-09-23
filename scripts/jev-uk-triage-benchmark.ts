/**
 * UK counterpart to jev-message-triage-benchmark.ts: backtests triageMessage against messages a
 * solicitor in England & Wales would actually send — CPR deadlines, Employment Tribunal
 * limitation, Housing Act notices, adjudication, statutory demands, PACE custody — rather than
 * the PH-weighted set the first benchmark grew from. One Jev call per message answers all three
 * questions (urgency, intent, refers-to-attachment), so this measures the same classifier the
 * legal_uk persona's turns go through.
 *
 *   npx ts-node scripts/jev-uk-triage-benchmark.ts
 *
 * Needs TYPESAFE_API_KEY and USE_JEV_MESSAGE_TRIAGE=true in the environment (triageMessage is a
 * no-op otherwise, and every case would score null):
 *
 *   USE_JEV_MESSAGE_TRIAGE=true npx ts-node scripts/jev-uk-triage-benchmark.ts
 *
 * No chat-wonder, no database — Jev only. Writes benchmarks/jev-uk-triage/<timestamp>.md.
 */
import * as dotenv from "dotenv";
dotenv.config();
import * as fs from "fs";
import * as path from "path";
import {
  triageMessage,
  missingAttachmentContextFor,
  MessageIntent,
  MESSAGE_INTENTS,
  INTENT_HINT_THRESHOLD,
  ATTACHMENT_THRESHOLD,
} from "../src/utils/message-triage";

interface Case {
  label: string;
  message: string;
  /** Expected urgency: is this time-critical for the lawyer receiving it? */
  expected: boolean;
  /** "explicit" — the message names a deadline, an emergency or an imminent hearing in words.
   *  "implicit" — urgency is only derivable from a date plus a rule the reader has to know
   *  (CPR periods, the ET three-month limitation, the 21 days on a statutory demand). */
  group: "explicit" | "implicit";
  intent: MessageIntent;
  /** Expected to depend on a document the user believes the assistant has. Omitted = not scored. */
  attachment?: boolean;
}

const CASES: Case[] = [
  // ── CONSULTATION — advice on the client's own situation ────────────────────
  {
    label: "adjudication referral due in 7 days",
    message:
      "Our client, a subcontractor, was served with a notice of adjudication this morning under the Housing Grants, Construction and Regeneration Act. The referral is due within 7 days. What are our options?",
    expected: true,
    group: "explicit",
    intent: "CONSULTATION",
    attachment: false,
  },
  {
    label: "client in police custody now (PACE)",
    message: "Client was arrested last night and is still in custody at the police station. The custody clock started at 11pm. Please advise on the review and detention limits.",
    expected: true,
    group: "explicit",
    intent: "CONSULTATION",
    attachment: false,
  },
  {
    label: "statutory demand served (21 days, unstated)",
    message: "The other side has served a statutory demand on our client company for £85,000. The client disputes the debt entirely. What should we be doing?",
    expected: true,
    group: "implicit",
    intent: "CONSULTATION",
    attachment: false,
  },
  {
    label: "rent arrears, no deadline",
    message: "A tenant has not paid rent since June and is ignoring our letters. The landlord wants possession. What is the position under the Housing Act 1988?",
    expected: false,
    group: "explicit",
    intent: "CONSULTATION",
    attachment: false,
  },
  {
    label: "restrictive covenant enforceability",
    message:
      "A former employee has set up a competing business and is approaching our client's customers. His contract has a 12-month non-compete covering the whole of England. Is it enforceable, and what are the client's options?",
    expected: false,
    group: "explicit",
    intent: "CONSULTATION",
    attachment: false,
  },

  // ── DEADLINE_COMPUTATION — "when is it due?" ───────────────────────────────
  {
    label: "defence deadline after acknowledgment (CPR 15.4)",
    message: "Particulars of claim were deemed served on 1 September and we filed an acknowledgment of service. By what date must the defence be filed under CPR 15.4?",
    expected: true,
    group: "implicit",
    intent: "DEADLINE_COMPUTATION",
    attachment: false,
  },
  {
    label: "ET1 limitation with ACAS stop-the-clock",
    message: "Dismissal took effect on 25 June 2026. ACAS early conciliation ran from 10 July to 24 July. What is the last day to present the ET1?",
    expected: true,
    group: "implicit",
    intent: "DEADLINE_COMPUTATION",
    attachment: false,
  },
  {
    label: "permission to appeal window",
    message: "The client received the judgment on 7 September. How long do we have to file an appellant's notice, and on what date does it expire?",
    expected: true,
    group: "implicit",
    intent: "DEADLINE_COMPUTATION",
    attachment: false,
  },
  {
    label: "judicial review promptness",
    message: "The decision we want to challenge was made on 2 August. When does the three-month long-stop for a judicial review claim under CPR 54.5 run out?",
    expected: true,
    group: "implicit",
    intent: "DEADLINE_COMPUTATION",
    attachment: false,
  },
  {
    label: "how periods are counted (no live deadline)",
    message: "As a general point — if a 14-day period under the CPR would end on a bank holiday Monday, when does it actually expire? I want to get the rule straight.",
    expected: false,
    group: "explicit",
    intent: "DEADLINE_COMPUTATION",
    attachment: false,
  },

  // ── DRAFT_DOCUMENT — instruments to sign, send or serve ────────────────────
  {
    label: "settlement agreement s.203 ERA",
    message:
      "Draft a settlement agreement compliant with section 203 of the Employment Rights Act 1996: £25,000 ex gratia, three months' PILON, mutual non-derogatory clause, and the usual confidentiality carve-outs for protected disclosures.",
    expected: false,
    group: "explicit",
    intent: "DRAFT_DOCUMENT",
    attachment: false,
  },
  {
    label: "letter before claim (pre-action protocol)",
    message: "Prepare a letter before claim under the Practice Direction on Pre-Action Conduct for an unpaid invoice of £42,000 owed by an English company, giving 14 days to respond.",
    expected: false,
    group: "explicit",
    intent: "DRAFT_DOCUMENT",
    attachment: false,
  },
  {
    label: "section 8 notice, grounds 8/10/11",
    message: "Draft a section 8 notice under the Housing Act 1988 relying on grounds 8, 10 and 11, for rent arrears of £6,400 on an assured shorthold tenancy.",
    expected: false,
    group: "explicit",
    intent: "DRAFT_DOCUMENT",
    attachment: false,
  },
  {
    label: "mutual NDA for a joint venture",
    message: "Write a mutual non-disclosure agreement between two English companies exploring a joint venture: three-year term, governed by the law of England and Wales, exclusive jurisdiction of the English courts.",
    expected: false,
    group: "explicit",
    intent: "DRAFT_DOCUMENT",
    attachment: false,
  },
  {
    label: "deed of variation of a lease",
    message: "Prepare a deed of variation extending the lease term by 15 years and revising the service charge apportionment from 12% to 15%.",
    expected: false,
    group: "explicit",
    intent: "DRAFT_DOCUMENT",
    attachment: false,
  },

  // ── DRAFT_PLEADING — court filings ─────────────────────────────────────────
  {
    label: "particulars of claim, defective goods",
    message: "Draft particulars of claim for breach of contract against a supplier who delivered defective goods worth £120,000, pleading the implied terms and consequential loss.",
    expected: false,
    group: "explicit",
    intent: "DRAFT_PLEADING",
    attachment: false,
  },
  {
    label: "defence and counterclaim to served particulars",
    message: "Prepare a defence and counterclaim to the particulars of claim we received — we deny the sums are due and counterclaim for defective workmanship.",
    expected: true,
    group: "implicit",
    intent: "DRAFT_PLEADING",
    attachment: true,
  },
  {
    label: "application to strike out (CPR 3.4(2)(a))",
    message: "We need an application notice under CPR 3.4(2)(a) to strike out the claim as disclosing no reasonable grounds for bringing it, together with a draft order.",
    expected: false,
    group: "explicit",
    intent: "DRAFT_PLEADING",
    attachment: false,
  },
  {
    label: "ET1 grounds, unfair dismissal + s.103A",
    message: "Draft the grounds of complaint for the ET1: ordinary unfair dismissal and automatic unfair dismissal under section 103A for making protected disclosures.",
    expected: false,
    group: "explicit",
    intent: "DRAFT_PLEADING",
    attachment: false,
  },
  {
    label: "skeleton argument, hearing Thursday",
    message: "The summary judgment hearing is listed for Thursday and we still have no skeleton argument. Draft it — the application is under CPR 24 on the construction of clause 9.",
    expected: true,
    group: "explicit",
    intent: "DRAFT_PLEADING",
    attachment: false,
  },

  // ── ANALYZE_DOCUMENT — read what the user supplied ─────────────────────────
  {
    label: "review uploaded SPA warranties",
    message: "I've uploaded the share purchase agreement. Please go through the warranties and the limitation of liability clause and flag anything unusual for a buyer.",
    expected: false,
    group: "explicit",
    intent: "ANALYZE_DOCUMENT",
    attachment: true,
  },
  {
    label: "lease: assignment without consent",
    message: "Please review the attached lease and tell me whether the tenant can assign the whole without the landlord's consent, and what conditions apply.",
    expected: false,
    group: "explicit",
    intent: "ANALYZE_DOCUMENT",
    attachment: true,
  },
  {
    label: "summarise a Court of Appeal judgment",
    message: "Here is the Court of Appeal judgment we discussed. Summarise the ratio and tell me whether it helps us on causation.",
    expected: false,
    group: "explicit",
    intent: "ANALYZE_DOCUMENT",
    attachment: true,
  },
  {
    label: "insurer's decline letter, reply due Friday",
    message: "The insurer's decline letter came in this morning and we have to respond by Friday. Read it and tell me whether the grounds they rely on actually stand up.",
    expected: true,
    group: "explicit",
    intent: "ANALYZE_DOCUMENT",
    attachment: true,
  },
  {
    label: "'see attached' with nothing attached",
    message: "See attached tenancy agreement. Is the break clause exercisable by the tenant in the second year?",
    expected: false,
    group: "explicit",
    intent: "ANALYZE_DOCUMENT",
    attachment: true,
  },

  // ── LEGAL_RESEARCH — what does the law say ─────────────────────────────────
  {
    label: "duty of care after Robinson",
    message: "What is the current approach to establishing a duty of care in negligence following Robinson v Chief Constable of West Yorkshire?",
    expected: false,
    group: "explicit",
    intent: "LEGAL_RESEARCH",
    attachment: false,
  },
  {
    label: "s.43B ERA qualifying disclosure",
    message: "What does section 43B of the Employment Rights Act 1996 define as a qualifying disclosure?",
    expected: false,
    group: "explicit",
    intent: "LEGAL_RESEARCH",
    attachment: false,
  },
  {
    label: "contractual interpretation line of authority",
    message: "How do the courts approach contractual interpretation following Arnold v Britton and Wood v Capita? Which authorities should I be citing?",
    expected: false,
    group: "explicit",
    intent: "LEGAL_RESEARCH",
    attachment: false,
  },
  {
    label: "Part 36 validity requirements",
    message: "What are the formal requirements for a valid Part 36 offer under the CPR, and what are the costs consequences of beating one at trial?",
    expected: false,
    group: "explicit",
    intent: "LEGAL_RESEARCH",
    attachment: false,
  },
  {
    label: "worker status after Uber v Aslam",
    message: "What test do the courts apply to worker status in the gig economy after Uber BV v Aslam?",
    expected: false,
    group: "explicit",
    intent: "LEGAL_RESEARCH",
    attachment: false,
  },

  // ── PARALEGAL_TASK — internal work product ─────────────────────────────────
  // Note: four of these are attachment: true. They name case material the assistant has to read
  // (the case documents, the bundle, the authorities list, the statements of case), so with
  // nothing attached the right behaviour is to say so — the guard firing is correct, not a false
  // positive. Only a paralegal task that needs no source document is attachment: false.
  {
    label: "chronology from the case file",
    message: "Build a chronology of events from the case documents, with the date, the event, and the source document for each entry.",
    expected: false,
    group: "explicit",
    intent: "PARALEGAL_TASK",
    attachment: true,
  },
  {
    label: "trial bundle index",
    message: "Prepare an index for the trial bundle in the order set out in the court's directions, with tab numbers and page references.",
    expected: false,
    group: "explicit",
    intent: "PARALEGAL_TASK",
    attachment: true,
  },
  {
    label: "OSCOLA citation formatting",
    message: "Convert the citations in our authorities list to OSCOLA format for the skeleton argument.",
    expected: false,
    group: "explicit",
    intent: "PARALEGAL_TASK",
    attachment: true,
  },
  {
    label: "list of issues for the CMC",
    message: "Draw up a list of issues for the case management conference based on the statements of case.",
    expected: false,
    group: "explicit",
    intent: "PARALEGAL_TASK",
    attachment: true,
  },
  {
    label: "trainee training outline (PD 57AC)",
    message: "We're running a session for trainees on the PD 57AC requirements for trial witness statements. Put together an outline for it.",
    expected: false,
    group: "explicit",
    intent: "PARALEGAL_TASK",
    attachment: false,
  },

  // ── REVISE_PREVIOUS — change what was already produced ─────────────────────
  {
    label: "revise: shorten for the client",
    message: "That's far too long for the client. Cut it to one page and keep only the three strongest points.",
    expected: false,
    group: "explicit",
    intent: "REVISE_PREVIOUS",
    attachment: false,
  },
  {
    label: "revise: add clause, change governing law",
    message: "Add an entire agreement clause and change the governing law to the law of England and Wales.",
    expected: false,
    group: "explicit",
    intent: "REVISE_PREVIOUS",
    attachment: false,
  },
  {
    label: "revise: wrong respondent named",
    message: "You've named the wrong respondent — it should be Meridian Structures Ltd, not Meridian Holdings Ltd. Please correct it throughout.",
    expected: false,
    group: "explicit",
    intent: "REVISE_PREVIOUS",
    attachment: false,
  },
  {
    label: "revise: plainer English",
    message: "Redraft that advice in plainer English for a lay client — no Latin, no case citations in the body.",
    expected: false,
    group: "explicit",
    intent: "REVISE_PREVIOUS",
    attachment: false,
  },
  {
    label: "revise: cut to the page limit",
    message: "Shorten the skeleton so it complies with the 25-page limit, but keep all the authorities.",
    expected: false,
    group: "explicit",
    intent: "REVISE_PREVIOUS",
    attachment: false,
  },

  // ── OTHER — no legal request ───────────────────────────────────────────────
  {
    label: "greeting",
    message: "Morning — are you around?",
    expected: false,
    group: "explicit",
    intent: "OTHER",
    attachment: false,
  },
  {
    label: "bare test message",
    message: "test",
    expected: false,
    group: "explicit",
    intent: "OTHER",
    attachment: false,
  },
  {
    label: "thanks",
    message: "Thanks, that's really helpful.",
    expected: false,
    group: "explicit",
    intent: "OTHER",
    attachment: false,
  },

  // ── implicit routine: UK dates that are NOT deadlines ──────────────────────
  {
    label: "implicit routine: date inside a citation",
    message: "In the House of Lords decision handed down on 26 May 1932, what principle did Lord Atkin set out?",
    expected: false,
    group: "implicit",
    intent: "LEGAL_RESEARCH",
    attachment: false,
  },
  {
    label: "implicit routine: far-future CLE date",
    message: "We're presenting at a client seminar on 30 November about the Building Safety Act. Put together an outline of the key duties.",
    expected: false,
    group: "implicit",
    intent: "PARALEGAL_TASK",
    attachment: false,
  },
  {
    label: "implicit routine: concluded matter",
    message: "The Tribunal handed down its judgment in March last year and the matter is closed. I'd like a short summary of the reasoning for our firm's newsletter.",
    expected: false,
    group: "implicit",
    intent: "PARALEGAL_TASK",
    attachment: false,
  },

  // ── implicit urgent: deadline buried in forwarded correspondence ───────────
  {
    label: "implicit: bailiff appointment in a forwarded email",
    message:
      "Forwarding what the client sent: 'Hope you're well. I've attached the photos of the damp you asked for. Also the county court sent something saying the bailiffs are coming on the 23rd but I assume that's automated.' Can you look at the damp evidence?",
    expected: true,
    group: "implicit",
    intent: "ANALYZE_DOCUMENT",
    attachment: true,
  },
  {
    label: "implicit: winding-up petition advertised",
    message: "Client mentioned in passing that a winding-up petition against their company was advertised in the Gazette last week. They want to talk about refinancing.",
    expected: true,
    group: "implicit",
    intent: "CONSULTATION",
    attachment: false,
  },
];

async function main() {
  const rows: string[] = [];
  let urgencyCorrect = 0;
  let intentCorrect = 0;
  let intentHintable = 0;
  let attachScored = 0;
  let attachCorrect = 0;
  let nullResults = 0;
  const urgentProbs: number[] = [];
  const routineProbs: number[] = [];
  const latencies: number[] = [];
  const byGroup: Record<Case["group"], { n: number; correct: number }> = { explicit: { n: 0, correct: 0 }, implicit: { n: 0, correct: 0 } };
  const byIntent: Record<string, { n: number; correct: number }> = {};
  const intentConfusions: string[] = [];
  const urgencyConfusions: string[] = [];
  const attachConfusions: string[] = [];

  for (const c of CASES) {
    const start = Date.now();
    const result = await triageMessage(c.message);
    const ms = Date.now() - start;
    latencies.push(ms);

    if (!result) {
      nullResults++;
      rows.push(`| ${c.label} | ${c.group} | ${c.expected ? "urgent" : "routine"} | null | no | ${c.intent} | null | no | — |`);
      console.log(`${c.label}: NULL (USE_JEV_MESSAGE_TRIAGE off, or Jev unavailable)`);
      continue;
    }

    // urgency
    byGroup[c.group].n++;
    if (result.urgent === c.expected) {
      urgencyCorrect++;
      byGroup[c.group].correct++;
    } else {
      urgencyConfusions.push(`${c.label}: expected ${c.expected ? "urgent" : "routine"}, got ${Math.round(result.probability * 100)}%`);
    }
    (c.expected ? urgentProbs : routineProbs).push(result.probability);

    // intent
    byIntent[c.intent] = byIntent[c.intent] ?? { n: 0, correct: 0 };
    byIntent[c.intent].n++;
    if (result.intent === c.intent) {
      intentCorrect++;
      byIntent[c.intent].correct++;
    } else {
      intentConfusions.push(`${c.label}: expected ${c.intent}, got ${result.intent} (${Math.round(result.intentConfidence * 100)}%)`);
    }
    if (result.intentConfidence >= INTENT_HINT_THRESHOLD) intentHintable++;

    // the missing-attachment guard, scored as if nothing were attached (the only case it fires in)
    const guardFires = missingAttachmentContextFor(result, false) !== "";
    if (c.attachment !== undefined) {
      attachScored++;
      if (guardFires === c.attachment) attachCorrect++;
      else attachConfusions.push(`${c.label}: expected guard ${c.attachment ? "to fire" : "not to fire"}, refersToAttachment ${Math.round(result.refersToAttachment * 100)}%`);
    }

    rows.push(
      `| ${c.label} | ${c.group} | ${c.expected ? "urgent" : "routine"} | ${result.urgent ? "urgent" : "routine"} (${Math.round(result.probability * 100)}%, ${ms}ms) | ${result.urgent === c.expected ? "yes" : "no"} | ${c.intent} | ${result.intent} (${Math.round(result.intentConfidence * 100)}%) | ${result.intent === c.intent ? "yes" : "no"} | ${Math.round(result.refersToAttachment * 100)}%${c.attachment !== undefined ? ` (exp ${c.attachment ? "fire" : "quiet"})` : ""} |`,
    );
    console.log(
      `${c.label}: urgency ${result.urgent ? "urgent" : "routine"} (${Math.round(result.probability * 100)}%)${result.urgent === c.expected ? "" : " ✗"} | intent ${result.intent} (${Math.round(result.intentConfidence * 100)}%)${result.intent === c.intent ? "" : ` ✗ exp ${c.intent}`} | attach ${Math.round(result.refersToAttachment * 100)}%`,
    );
  }

  const scored = CASES.length - nullResults;
  const pct = (n: number, d: number) => (d ? `${n}/${d} (${Math.round((n / d) * 100)}%)` : "n/a");
  const avg = (arr: number[]) => (arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) : null);
  const avgMs = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;

  const summary = [
    `# Jev triage benchmark — England & Wales`,
    ``,
    `Run: ${new Date().toISOString()}`,
    ``,
    `Messages a solicitor in England & Wales would actually send, hand-labelled for urgency, intent`,
    `and whether the message depends on a document the user believes they supplied. One Jev call per`,
    `message answers all three; no chat-wonder and no database are involved.`,
    ``,
    `| Case | Group | Expected urgency | Jev urgency | ✓ | Expected intent | Jev intent | ✓ | refersToAttachment |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
    ...rows,
    ``,
    `## Summary`,
    ``,
    `- Cases: ${CASES.length} (${CASES.filter((c) => c.expected).length} urgent, ${CASES.filter((c) => !c.expected).length} routine)${nullResults ? ` — ${nullResults} returned null and are excluded` : ""}`,
    `- Avg Jev latency: ${avgMs}ms per message (all three questions)`,
    ``,
    `### Urgency`,
    ``,
    `- Accuracy: ${pct(urgencyCorrect, scored)}`,
    `- Explicit wording: ${pct(byGroup.explicit.correct, byGroup.explicit.n)}`,
    `- Implicit (a UK date or period the reader must know): ${pct(byGroup.implicit.correct, byGroup.implicit.n)}`,
    `- Avg probability on urgent cases: ${avg(urgentProbs)}%`,
    `- Avg probability on routine cases: ${avg(routineProbs)}%`,
    ...(urgencyConfusions.length ? [``, `Misclassified:`, ...urgencyConfusions.map((x) => `- ${x}`)] : []),
    ``,
    `### Intent`,
    ``,
    `- Accuracy: ${pct(intentCorrect, scored)}`,
    `- At or above INTENT_HINT_THRESHOLD (${INTENT_HINT_THRESHOLD}) — i.e. a steer would be injected: ${pct(intentHintable, scored)}`,
    ...MESSAGE_INTENTS.filter((k) => byIntent[k]).map((k) => `- ${k}: ${pct(byIntent[k].correct, byIntent[k].n)}`),
    ...(intentConfusions.length ? [``, `Misclassified:`, ...intentConfusions.map((x) => `- ${x}`)] : []),
    ``,
    `### Missing-attachment guard`,
    ``,
    `Scored through missingAttachmentContextFor as if nothing were attached — threshold`,
    `${ATTACHMENT_THRESHOLD}, never fires on REVISE_PREVIOUS.`,
    ``,
    `- Fires when it should: ${pct(attachCorrect, attachScored)}`,
    ...(attachConfusions.length ? [``, `Misclassified:`, ...attachConfusions.map((x) => `- ${x}`)] : []),
  ].join("\n");

  const outDir = path.resolve(__dirname, "..", "benchmarks", "jev-uk-triage");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  fs.writeFileSync(outFile, summary);
  console.log(`\n${summary.slice(summary.indexOf("## Summary"))}\n\nWritten to ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
