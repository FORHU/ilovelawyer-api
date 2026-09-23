/**
 * Runs real consultation turns through the ACTUAL worker path — ChatSvc.processChatGenerationJob
 * (Jev triage → context injection → RAG/grounding → chat-wonder /chat-stream → canonical
 * persistence) — rather than calling streamChatWonderMessage directly the way
 * jev-chat-context-benchmark.ts does. Every turn lands as real Message rows in a fresh,
 * clearly-labelled consultation ("[Jev benchmark] ...") under the org/user given below.
 *
 * Deliberately does NOT go through ChatSvc.enqueueChatGeneration: that sends the job to the real
 * SQS queue (MESSAGE_PERSISTENCE_QUEUE_URL), and whichever deployed worker is polling it would
 * pick the job up with ITS env flags, not this process's. The enqueue-side steps it skips (PENDING
 * user Message row, session resolution) are reproduced inline below.
 *
 * USE_JEV_MESSAGE_TRIAGE is read once at module load (message-triage.ts), so one process = one
 * mode. Run it twice to compare:
 *
 *   USE_JEV_MESSAGE_TRIAGE=false npx ts-node scripts/jev-consultation-benchmark.ts
 *   USE_JEV_MESSAGE_TRIAGE=true  npx ts-node scripts/jev-consultation-benchmark.ts
 *
 * Optional: JEV_BENCH_ORG_ID / JEV_BENCH_USER_ID override the target org/user; JEV_BENCH_ONLY=<substring>
 * runs just the cases whose label contains it (re-running one turn after a chat-wonder hiccup). Requires
 * DATABASE_URL, CHAT_WONDER_WS_URL and (for mode=on) TYPESAFE_API_KEY. Redis is optional — without
 * it every turn just gets a fresh chat-wonder session, which is what we want for independent
 * turns anyway. Writes results to benchmarks/jev-consultation/<timestamp>-<mode>.md.
 */
import * as dotenv from "dotenv";
dotenv.config();
import * as fs from "fs";
import * as path from "path";
import Transport from "winston-transport";
import prisma from "../src/lib/prisma";
import logger from "../src/utils/logger";
import ChatSvc from "../src/services/chat.service";
import ChatRepo from "../src/repositories/chat.repository";
import { getChatWonderSessionId } from "../src/utils/chatWonder";
import { ChatGenerationJob } from "../src/queues/chat-generation.queue";
import { triageContextFor, MessageIntent } from "../src/utils/message-triage";
import { TenantCode } from "../src/types/tenant-code";

const MODE = process.env.USE_JEV_MESSAGE_TRIAGE === "true" ? "on" : "off";
// Faker-seeded staging org ("Voluptatum et impedi", PH tenant) and its owner — throwaway data.
const ORG_ID = process.env.JEV_BENCH_ORG_ID ?? "9b2aa0ae-5c9f-48c4-ab5c-86073abd2123";
const USER_ID = process.env.JEV_BENCH_USER_ID ?? "ddbaccf2-c2b2-44b5-af05-aa05f38e5ddc";
const TENANT: TenantCode = "PH";

interface Case {
  label: string;
  userInput: string;
  expectedUrgent: boolean;
  expectedIntent?: MessageIntent;
}

// Same two urgent prompts as jev-chat-context-benchmark.ts, one routine control so the injection
// log can be checked for a true negative, and two IMPLICIT cases (a date + statutory period, a
// deadline buried in a pasted email) where the injected note could tell chat-wonder something it
// wouldn't have inferred on its own — see jev-report-2026-09-21.md §5.
const CASES: Case[] = [
  {
    label: "eviction, 48hr deadline",
    userInput:
      "Our client just received a Notice to Vacate with a 48-hour compliance deadline — the sheriff is scheduled to execute tomorrow morning. What can we file right now to stop this?",
    expectedUrgent: true,
  },
  {
    label: "statute of limitations expires tonight",
    userInput: "Statute of limitations on this claim expires at midnight tonight — what are our options?",
    expectedUrgent: true,
  },
  {
    label: "routine control (annulment question)",
    userInput: "Can you give me a general overview of the grounds for annulment of marriage under the Family Code of the Philippines?",
    expectedUrgent: false,
  },
  {
    label: "implicit: served date + 15-day answer period",
    userInput: "We received the summons and complaint on September 8. The client only brought it to me today, the 21st. What do we do about the answer?",
    expectedUrgent: true,
  },
  {
    label: "intent: draft a demand letter (routine)",
    userInput:
      "Draft a demand letter to our client's tenant for unpaid rent of PHP 90,000 covering June to August 2026 under a lease dated 1 January 2026, giving 15 days to pay or vacate.",
    expectedUrgent: false,
    expectedIntent: "DRAFT_DOCUMENT",
  },
  {
    label: "implicit: foreclosure buried in pasted email",
    userInput:
      "Forwarding what the client sent — 'Hi, hope you're well. Attached are the photos from the site visit like you asked. Also the bank sent a letter saying they'll foreclose if the arrears aren't settled by Wednesday but I think that's a bluff. Anyway let me know about the photos.' Can you look at the photos issue?",
    expectedUrgent: true,
  },
];

/** Crude "did the answer lead with the action" check for the rewritten note (see
 * urgencyContextFor): index of the first numbered/bulleted list item, as a share of the reply.
 * Lower = the checklist came sooner. */
function firstChecklistPosition(text: string): number | null {
  const m = text.match(/^\s*(?:\d+[.)]|[-*])\s/m);
  return m && m.index !== undefined && text.length ? Math.round((m.index / text.length) * 100) : null;
}

const URGENCY_WORDS = ["urgent", "immediately", "right away", "as soon as possible", "asap", "priority", "prioritize", "emergency", "time-sensitive", "without delay", "tonight", "today"];

function countUrgencyLanguage(text: string): number {
  const lower = text.toLowerCase();
  return URGENCY_WORDS.reduce((n, w) => n + (lower.includes(w) ? 1 : 0), 0);
}

/** Captures the structured log lines the worker path emits for Jev (message-triage.ts and the
 * "Jev chat context injection" line in chat.service.ts) so the report can show exactly what the
 * real code path saw and injected, without a second Jev call. */
interface JevTrace {
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
  injection?: Record<string, unknown>;
  error?: Record<string, unknown>;
  streamFinished?: Record<string, unknown>;
}
let currentTrace: JevTrace = {};

class CaptureTransport extends Transport {
  log(info: Record<string, unknown>, next: () => void) {
    const msg = String(info.message ?? "");
    if (info.feature === "message-triage") {
      if (msg === "Jev request") currentTrace.request = info;
      else if (msg === "Jev response") currentTrace.response = info;
      else if (msg === "Jev error") currentTrace.error = info;
      else if (msg === "Jev chat context injection") currentTrace.injection = info;
    } else if (msg === "Chat Wonder: stream finished") {
      currentTrace.streamFinished = info;
    }
    next();
  }
}
logger.add(new CaptureTransport());

interface TurnResult {
  c: Case;
  userMessageId: string;
  assistantMessageId: string | null;
  replyStatus: string | null;
  /** Persisted triage columns (Message.urgent / urgencyProbability, Consultation.urgentAt) —
   * proves the write path, not just the log line. */
  persisted: { urgent: boolean | null; urgencyProbability: number | null; intent: string | null; intentConfidence: number | null; consultationUrgentAt: Date | null };
  content: string;
  ms: number;
  trace: JevTrace;
  error?: string;
}

async function runTurn(consultationId: string, c: Case): Promise<TurnResult> {
  currentTrace = {};
  // --- what ChatSvc.enqueueChatGeneration does before handing off to the queue ---
  const sessionId = await getChatWonderSessionId();
  const userMessage = await ChatRepo.createMessage(consultationId, "user", c.userInput, USER_ID, undefined, undefined, undefined, undefined, "PENDING");
  const job: ChatGenerationJob = {
    jobId: userMessage.id,
    organizationId: ORG_ID,
    tenantCode: TENANT,
    userId: USER_ID,
    consultationId,
    sessionId,
    userInput: c.userInput,
    effectiveCaseId: null,
    enqueuedAt: Date.now(),
  };

  // --- the worker ---
  const start = Date.now();
  let error: string | undefined;
  try {
    await ChatSvc.processChatGenerationJob(job);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const ms = Date.now() - start;

  const reply = await prisma.message.findFirst({
    where: { parentMessageId: userMessage.id, role: "assistant" },
    select: { id: true, content: true },
  });
  const parent = await prisma.message.findUnique({
    where: { id: userMessage.id },
    select: { replyStatus: true, urgent: true, urgencyProbability: true, intent: true, intentConfidence: true, consultation: { select: { urgentAt: true } } },
  });

  return {
    c,
    userMessageId: userMessage.id,
    assistantMessageId: reply?.id ?? null,
    replyStatus: parent?.replyStatus ?? null,
    persisted: {
      urgent: parent?.urgent ?? null,
      urgencyProbability: parent?.urgencyProbability ?? null,
      intent: parent?.intent ?? null,
      intentConfidence: parent?.intentConfidence ?? null,
      consultationUrgentAt: parent?.consultation.urgentAt ?? null,
    },
    content: reply?.content ?? "",
    ms,
    trace: currentTrace,
    error,
  };
}

async function main() {
  const startedAt = new Date();
  const consultation = await ChatRepo.createConsultation(
    ORG_ID,
    USER_ID,
    `[Jev benchmark] triage=${MODE} ${startedAt.toISOString()}`,
  );
  console.log(`mode=${MODE} consultation=${consultation.id}`);

  const only = process.env.JEV_BENCH_ONLY;
  const cases = only ? CASES.filter((c) => c.label.includes(only)) : CASES;
  if (!cases.length) throw new Error(`JEV_BENCH_ONLY=${only} matched no case`);

  const results: TurnResult[] = [];
  for (const c of cases) {
    console.log(`\n=== ${c.label} ===`);
    const r = await runTurn(consultation.id, c);
    results.push(r);
    const inj = r.trace.injection;
    console.log(
      `  ${r.ms}ms  replyStatus=${r.replyStatus}  ${r.content.length} chars  urgency-language hits: ${countUrgencyLanguage(r.content)}  first checklist at ${firstChecklistPosition(r.content) ?? "—"}%` +
        (inj ? `  | jev urgent=${inj.urgent} p=${inj.probability} injected=${inj.injected}` : "  | no injection log") +
        `  | persisted urgent=${r.persisted.urgent} p=${r.persisted.urgencyProbability} intent=${r.persisted.intent} (${r.persisted.intentConfidence}) urgentAt=${r.persisted.consultationUrgentAt?.toISOString() ?? null}` +
        (r.error ? `  | ERROR ${r.error}` : ""),
    );
  }

  const rows = results.map((r) => {
    const inj = r.trace.injection;
    const p = typeof inj?.probability === "number" ? `${Math.round(inj.probability * 100)}%` : "—";
    const sf = r.trace.streamFinished;
    const persisted = r.persisted.urgent === null ? "—" : `${r.persisted.urgent} / ${r.persisted.consultationUrgentAt ? "set" : "null"}`;
    const intentCell = r.persisted.intent ? `${r.persisted.intent} (${Math.round((r.persisted.intentConfidence ?? 0) * 100)}%)${r.c.expectedIntent ? (r.persisted.intent === r.c.expectedIntent ? " ✓" : ` ✗ exp ${r.c.expectedIntent}`) : ""}` : "—";
    return `| ${r.c.label} | ${r.c.expectedUrgent ? "urgent" : "routine"} | ${inj ? String(inj.urgent) : "—"} (${p}) | ${intentCell} | ${inj ? String(inj.injected) : "—"} | ${persisted} | ${r.replyStatus ?? "—"} | ${r.content.length} | ${countUrgencyLanguage(r.content)} | ${firstChecklistPosition(r.content) ?? "—"}% | ${r.ms}ms | ${sf?.timeToFirstChunkMs ?? "—"}ms |`;
  });

  const sections = results.map((r) =>
    [
      `## ${r.c.label}`,
      ``,
      `**Message:** ${r.c.userInput}`,
      ``,
      `- User message: \`${r.userMessageId}\` (replyStatus ${r.replyStatus})`,
      `- Assistant message: \`${r.assistantMessageId ?? "none"}\``,
      `- Jev trace: ${r.trace.response ? `urgent=${r.trace.response.urgent} probability=${r.trace.response.probability}` : r.trace.error ? `error ${JSON.stringify(r.trace.error.err)}` : "no Jev call (flag off)"}`,
      `- Injected into resolvedContext: ${r.trace.injection ? String(r.trace.injection.injected) : "—"}`,
      `- Persisted: Message.urgent=${r.persisted.urgent} urgencyProbability=${r.persisted.urgencyProbability} intent=${r.persisted.intent} intentConfidence=${r.persisted.intentConfidence} Consultation.urgentAt=${r.persisted.consultationUrgentAt?.toISOString() ?? null}`,
      r.error ? `- **Worker error:** ${r.error}` : "",
      ``,
      `### Response`,
      ``,
      r.content || "_(empty)_",
    ]
      .filter((l) => l !== "")
      .join("\n"),
  );

  const summary = [
    `# Jev consultation benchmark — real worker path (USE_JEV_MESSAGE_TRIAGE=${MODE})`,
    ``,
    `Run: ${startedAt.toISOString()}`,
    `Consultation: \`${consultation.id}\` (org \`${ORG_ID}\`, tenant ${TENANT})`,
    ``,
    `Each turn = PENDING user Message row + ChatSvc.processChatGenerationJob (the SQS worker's entry`,
    `point), i.e. the same code that runs for a real POST /consultations/:id/messages, minus SQS.`,
    ``,
    `Context injected on an urgent DRAFT_PLEADING turn (triageContextFor; urgency block only on urgent turns, intent hint only for document/pleading/analysis/paralegal intents at ≥ 0.7 confidence):`,
    ``,
    "```",
    triageContextFor({ urgent: true, probability: 0.99, intent: "DRAFT_PLEADING", intentConfidence: 0.9, intentProbabilities: {}, refersToAttachment: 0.1 }),
    "```",
    ``,
    `| Case | Expected | Jev urgent (p) | Jev intent | Injected | Persisted urgent / urgentAt | replyStatus | Chars | Urgency words | First checklist | Total | First chunk |`,
    `| --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |`,
    ...rows,
    ``,
    ...sections,
  ].join("\n\n");

  const outDir = path.resolve(__dirname, "..", "benchmarks", "jev-consultation");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${startedAt.toISOString().replace(/[:.]/g, "-")}-${MODE}.md`);
  fs.writeFileSync(outFile, summary);
  console.log(`\nWritten to ${outFile}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    // The redis client keeps retrying forever when nothing is listening; don't let it hold the
    // process open.
    setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
  });
