/**
 * Ask a benchmark's questions against its seeded case through ChatSvc.sendMessage — the real
 * production path (case context + ranked chunks + manifest + whole-case inline + [legal ai] tag)
 * — and save the answers for grading.
 *
 *   npx ts-node scripts/run-benchmark.ts --bench brackenmoor --org magni-beatae-tempora [--only Q2] [--label after-fix]
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

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const BENCH_SLUG = arg("bench") || "brackenmoor";
const BENCH_DIR = path.resolve(__dirname, "..", "benchmarks", BENCH_SLUG);

function stripTraceFrames(text: string): string {
  return text.replace(/\[TRACE\][\s\S]*?\[\/TRACE\]/g, "");
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
  const caseRow = await prisma.case.findFirst({ where: { organizationId: org.id, caseName: q.caseName } });
  if (!caseRow) throw new Error(`Benchmark case not seeded in ${org.slug} — run scripts/seed-benchmark.ts first`);
  const consultation = await prisma.consultation.findFirst({
    where: { caseId: caseRow.id, title: { in: [`Benchmark: ${BENCH_SLUG}`, "Brackenmoor Wharf Benchmark (D21)"] } },
  });
  if (!consultation) throw new Error("Benchmark consultation not found — re-run the seed script");
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
    consultationId: consultation.id,
    chatWonder: { ws: process.env.CHAT_WONDER_WS_URL, api: process.env.CHAT_WONDER_API_URL },
    questions: [] as any[],
  };

  for (const item of q.questions) {
    if (only && item.id !== only) continue;
    const prompt = `${q.preamble}\n\n${item.title.toUpperCase()}\n\n${item.prompt}`;
    console.log(`\n=== ${item.id} — ${item.title}`);
    const t0 = Date.now();
    let text = "";
    let chunks = 0;
    let error: string | undefined;
    try {
      await ChatSvc.sendMessage(org.id, q.tenant ?? "UK", consultation.userId, consultation.id, "", prompt, (c) => {
        text += c;
        chunks++;
        if (chunks % 50 === 0) process.stdout.write(".");
      });
    } catch (e) {
      error = (e as Error).message;
      console.error(`\n${item.id} failed:`, error);
    }
    const seconds = (Date.now() - t0) / 1000;
    const clean = stripTraceFrames(text).trim();
    fs.writeFileSync(path.join(outDir, `${item.id}.md`), clean);
    const entry: any = { id: item.id, title: item.title, seconds: Math.round(seconds * 10) / 10, chars: clean.length, words: clean.split(/\s+/).length, error };
    if (logPath && fs.existsSync(logPath)) entry.profile = profileFromLog(logPath, t0);
    run.questions.push(entry);
    console.log(`\n${item.id}: ${clean.length} chars, ${seconds.toFixed(1)}s${entry.profile ? `, tools ${JSON.stringify(entry.profile.tools)}` : ""}`);
  }

  fs.writeFileSync(path.join(outDir, "run.json"), JSON.stringify(run, null, 2));
  console.log(`\nrun.json written. Next: npx ts-node scripts/grade-benchmark.ts --bench ${BENCH_SLUG} --answers ${path.basename(outDir)}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
