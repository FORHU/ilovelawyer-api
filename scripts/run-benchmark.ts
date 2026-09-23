/**
 * Ask a benchmark's questions against its seeded case through the real worker path —
 * ChatSvc.processChatGenerationJob (case context + ranked chunks + manifest + whole-case inline +
 * [legal ai] tag + Jev triage when USE_JEV_MESSAGE_TRIAGE is on) — and save the answers for grading.
 * Bypasses ChatSvc.enqueueChatGeneration on purpose: that hands the job to the real SQS queue and
 * the deployed worker would run it with ITS flags (see scripts/jev-consultation-benchmark.ts).
 *
 *   npx ts-node scripts/run-benchmark.ts --bench brackenmoor --org magni-beatae-tempora [--only Q2] [--label after-fix]
 *
 * --consultation <id> targets an arbitrary consultation instead of the seeded benchmark one — the
 * case it belongs to is used for grounding, whatever its name. Pair with --case on
 * grade-benchmark.ts so the grader reads the same bundle.
 *
 * --rebuild <answers-folder> re-writes Qn.md from the DB using the userMessageIds in that folder's
 * run.json, without asking anything again. A long legal answer is persisted as a MessageGroup of
 * several assistant rows (one per topic), so the reply is reassembled from every row hanging off
 * the user message, in groupOrder.
 *
 * Streams from whatever CHAT_WONDER_WS_URL / CHAT_WONDER_API_URL the .env points at. To
 * benchmark uncommitted chat-wonder code, run it locally and override both:
 *
 *   CHAT_WONDER_WS_URL=ws://127.0.0.1:8000/chat-stream CHAT_WONDER_API_URL=http://127.0.0.1:8000 \
 *     npx ts-node scripts/run-benchmark.ts --bench brackenmoor --org magni-beatae-tempora
 *
 * Output: benchmarks/<slug>/answers/<YYYY-MM-DD[-label]>/{Qn.md, run.json}. Qn.md is the reply
 * with [TRACE] research-step frames stripped (the app strips them the same way); run.json records
 * timing and, when --chat-wonder-log points at a local chat-wonder log, the tool-call histogram
 * and verifier events for the run. Grade with scripts/grade-benchmark.ts.
 */
import * as dotenv from "dotenv";
dotenv.config();
import * as fs from "fs";
import * as path from "path";
import prisma from "../src/lib/prisma";
import ChatSvc from "../src/services/chat.service";
import ChatRepo from "../src/repositories/chat.repository";
import { getChatWonderSessionId } from "../src/utils/chatWonder";
import { ChatGenerationJob } from "../src/queues/chat-generation.queue";
import { TenantCode } from "../src/types/tenant-code";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const BENCH_SLUG = arg("bench") || "brackenmoor";
const BENCH_DIR = path.resolve(__dirname, "..", "benchmarks", BENCH_SLUG);

function stripTraceFrames(text: string): string {
  return text.replace(/\[TRACE\][\s\S]*?\[\/TRACE\]/g, "");
}

/** The persisted reply to a user message: every assistant row hanging off it, in groupOrder (a
 * multi-topic answer is split into one row per topic — see MessageGroup in the schema), joined
 * back into one document. Also returns the ids so run.json can point at them. */
async function assembleReply(userMessageId: string): Promise<{ content: string; parts: number; ids: string[] }> {
  const rows = await prisma.message.findMany({
    where: { parentMessageId: userMessageId, role: "assistant" },
    orderBy: [{ groupOrder: "asc" }, { createdAt: "asc" }],
    select: { id: true, content: true },
  });
  return { content: rows.map((r) => r.content).join("\n\n"), parts: rows.length, ids: rows.map((r) => r.id) };
}

async function rebuild(answersDir: string) {
  const runPath = path.join(answersDir, "run.json");
  const run = JSON.parse(fs.readFileSync(runPath, "utf-8"));
  for (const entry of run.questions) {
    if (!entry.userMessageId) continue;
    const reply = await assembleReply(entry.userMessageId);
    const clean = stripTraceFrames(reply.content).trim();
    fs.writeFileSync(path.join(answersDir, `${entry.id}.md`), clean);
    entry.chars = clean.length;
    entry.words = clean.split(/\s+/).length;
    entry.parts = reply.parts;
    entry.assistantMessageIds = reply.ids;
    console.log(`${entry.id}: ${reply.parts} parts, ${clean.length} chars`);
  }
  fs.writeFileSync(runPath, JSON.stringify(run, null, 2));
}

/** Tool-call histogram + verifier/gate events from a chat-wonder log, sliced from `since`. */
function profileFromLog(logPath: string, since: number) {
  const log = fs.readFileSync(logPath, "utf-8");
  const lines = log.split("\n");
  const tools: Record<string, number> = {};
  const verify: string[] = [];
  const gates: string[] = [];
  let forced = 0;
  for (const line of lines) {
    const ts = Date.parse(line.slice(0, 23).replace(",", "."));
    if (!Number.isNaN(ts) && ts < since) continue;
    const m = /chain\[\d+\] LLM(?:→|\\u2192)tool=(\w+)/.exec(line);
    if (m) tools[m[1]] = (tools[m[1]] ?? 0) + 1;
    const v = /\[legal-verify\] (.*)$/.exec(line);
    if (v) verify.push(v[1].trim());
    const g = /\[legal-citation\] (.*)$/.exec(line);
    if (g) gates.push(g[1].trim());
    if (line.includes("maximum number of tool calls")) forced++;
  }
  return { tools, verify, gates, forced };
}

async function main() {
  const rebuildArg = arg("rebuild");
  if (rebuildArg) return rebuild(path.join(BENCH_DIR, "answers", rebuildArg));

  const questionsPath = path.join(BENCH_DIR, "questions.json");
  if (!fs.existsSync(questionsPath)) throw new Error(`No benchmark at ${BENCH_DIR}`);
  const q = JSON.parse(fs.readFileSync(questionsPath, "utf-8"));
  const only = arg("only");
  const label = arg("label");
  const stamp = new Date().toISOString().slice(0, 10) + (label ? `-${label}` : "");
  const outDir = arg("out") || path.join(BENCH_DIR, "answers", stamp);
  fs.mkdirSync(outDir, { recursive: true });
  const logPath = arg("chat-wonder-log");

  const orgArg = arg("org") || "";
  const org = await prisma.organization.findFirst({ where: { OR: [{ slug: orgArg }, { id: orgArg }] } });
  if (!org) throw new Error("--org <slug|id> is required and must exist");
  const consultationArg = arg("consultation");
  const consultation = consultationArg
    ? await prisma.consultation.findFirst({ where: { id: consultationArg, organizationId: org.id } })
    : await prisma.consultation.findFirst({
        where: {
          case: { organizationId: org.id, caseName: q.caseName },
          title: { in: [`Benchmark: ${BENCH_SLUG}`, "Brackenmoor Wharf Benchmark (D21)"] },
        },
      });
  if (!consultation) throw new Error(consultationArg ? `Consultation ${consultationArg} not found in ${org.slug}` : "Benchmark consultation not found — re-run the seed script");
  if (!consultation.caseId) throw new Error(`Consultation ${consultation.id} is not linked to a case`);
  const caseRow = await prisma.case.findUniqueOrThrow({ where: { id: consultation.caseId } });
  const docs = await prisma.document.findMany({ where: { caseId: caseRow.id }, select: { ragStatus: true } });
  const ready = docs.filter((d) => d.ragStatus === "READY").length;
  if (ready < docs.length) console.warn(`WARNING: only ${ready}/${docs.length} documents READY`);

  console.log(`benchmark ${BENCH_SLUG} — case ${caseRow.id} — ${ready}/${docs.length} docs READY — consultation ${consultation.id}`);
  console.log(`WS: ${process.env.CHAT_WONDER_WS_URL}  API: ${process.env.CHAT_WONDER_API_URL}`);
  console.log(`answers → ${outDir}`);

  const run: any = {
    benchmark: BENCH_SLUG,
    ranAt: new Date().toISOString(),
    caseId: caseRow.id,
    caseName: caseRow.caseName,
    consultationId: consultation.id,
    chatWonder: { ws: process.env.CHAT_WONDER_WS_URL, api: process.env.CHAT_WONDER_API_URL },
    jev: { messageTriage: process.env.USE_JEV_MESSAGE_TRIAGE === "true" },
    questions: [] as any[],
  };
  const tenant = (q.tenant ?? "UK") as TenantCode;

  for (const item of q.questions) {
    if (only && item.id !== only) continue;
    const prompt = `${q.preamble}\n\n${item.title.toUpperCase()}\n\n${item.prompt}`;
    console.log(`\n=== ${item.id} — ${item.title}`);
    // What enqueueChatGeneration does before the queue hand-off, then the worker itself.
    const sessionId = await getChatWonderSessionId();
    const userMessage = await ChatRepo.createMessage(consultation.id, "user", prompt, consultation.userId, undefined, undefined, undefined, undefined, "PENDING");
    const job: ChatGenerationJob = {
      jobId: userMessage.id,
      organizationId: org.id,
      tenantCode: tenant,
      userId: consultation.userId,
      consultationId: consultation.id,
      sessionId,
      userInput: prompt,
      effectiveCaseId: caseRow.id,
      enqueuedAt: Date.now(),
    };
    const t0 = Date.now();
    let error: string | undefined;
    try {
      await ChatSvc.processChatGenerationJob(job);
    } catch (e) {
      error = (e as Error).message;
      console.error(`\n${item.id} failed:`, error);
    }
    const seconds = (Date.now() - t0) / 1000;
    const reply = await assembleReply(userMessage.id);
    const parent = await prisma.message.findUnique({ where: { id: userMessage.id }, select: { replyStatus: true, urgent: true, urgencyProbability: true } });
    const clean = stripTraceFrames(reply.content).trim();
    fs.writeFileSync(path.join(outDir, `${item.id}.md`), clean);
    const entry: any = {
      id: item.id,
      title: item.title,
      seconds: Math.round(seconds * 10) / 10,
      chars: clean.length,
      words: clean.split(/\s+/).length,
      error,
      userMessageId: userMessage.id,
      assistantMessageIds: reply.ids,
      parts: reply.parts,
      replyStatus: parent?.replyStatus ?? null,
      jevUrgent: parent?.urgent ?? null,
      jevProbability: parent?.urgencyProbability ?? null,
    };
    if (logPath && fs.existsSync(logPath)) entry.profile = profileFromLog(logPath, t0);
    run.questions.push(entry);
    console.log(`\n${item.id}: ${clean.length} chars in ${reply.parts} parts, ${seconds.toFixed(1)}s, replyStatus=${entry.replyStatus}, jev urgent=${entry.jevUrgent} p=${entry.jevProbability}${entry.profile ? `, tools ${JSON.stringify(entry.profile.tools)}` : ""}`);
  }

  fs.writeFileSync(path.join(outDir, "run.json"), JSON.stringify(run, null, 2));
  console.log(`\nrun.json written. Next: npx ts-node scripts/grade-benchmark.ts --bench ${BENCH_SLUG} --answers ${path.basename(outDir)}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    // The redis client retries forever when nothing is listening; don't let it hold the process open.
    setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
  });
