/**
 * Grade a benchmark run: an AI grader that reads the WHOLE bundle text (from the seeded case's
 * chunks), the question, the answer and the rubric, and scores each criterion with a
 * justification. Writes scorecard.json + moderation.md into the answers folder and appends a
 * line to benchmarks/scores.md.
 *
 *   npx ts-node scripts/grade-benchmark.ts --bench brackenmoor --org magni-beatae-tempora --answers 2026-09-13-after-fix [--only Q1]
 *
 * The score is AI-moderated: moderation.md is a sheet for a solicitor to confirm or adjust each
 * criterion; the scorecard records `moderated: false` until someone fills it in. Grader model:
 * BENCHMARK_GRADER_MODEL (default gpt-5.6-terra, reasoning high) via the OpenAI Responses API,
 * using OPENAI_API_KEY from .env.
 */
import * as dotenv from "dotenv";
dotenv.config();
import * as fs from "fs";
import * as path from "path";
import OpenAI from "openai";
import prisma from "../src/lib/prisma";
import DocumentChunkRepo from "../src/repositories/document-chunk.repository";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const BENCH_SLUG = arg("bench") || "brackenmoor";
const BENCH_DIR = path.resolve(__dirname, "..", "benchmarks", BENCH_SLUG);
const MODEL = process.env.BENCHMARK_GRADER_MODEL || "gpt-5.6-terra";

type Criterion = { id: string; name: string; weight: number; guidance: string };
type Rubric = { version: number; passMark: number; criteria: Criterion[] };
type CriterionScore = { id: string; score: number; justification: string; evidence: string[] };

async function bundleText(caseId: string): Promise<string> {
  const docs = await prisma.document.findMany({ where: { caseId, ragStatus: "READY" }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  const texts = await DocumentChunkRepo.findFullTextsByDocuments(docs.map((d) => d.id));
  return docs.map((d) => `===== ${d.name} =====\n${texts.get(d.id) ?? ""}`).join("\n\n");
}

function gradingPrompt(rubric: Rubric, guidance: string[], question: { id: string; title: string; prompt: string }, answer: string, bundle: string): string {
  const criteria = rubric.criteria
    .map((c) => `- ${c.id} · ${c.name} (max ${c.weight}): ${c.guidance}`)
    .join("\n");
  return [
    "You are an examiner marking a piece of written legal advice against a fictional litigation bundle and a marking scheme. Be exacting and specific. Check every factual assertion in the answer against the bundle text below; treat an assertion the bundle contradicts, or a paragraph the answer says it 'could not see' when it is present, as a grounding failure. Do not reward length.",
    "",
    "MARKING GUIDANCE (from the assessment paper):",
    guidance.map((g) => `- ${g}`).join("\n"),
    "",
    "CRITERIA (score each 0..max, integers):",
    criteria,
    "",
    "Return ONLY a JSON object: {\"scores\": [{\"id\": \"A\", \"score\": int, \"justification\": \"2-4 sentences naming specific strengths and specific defects\", \"evidence\": [\"short quote or document/para reference supporting the deduction or award\", ...]}, ...], \"overall_comment\": \"3-5 sentences\"}",
    "",
    `QUESTION ${question.id} — ${question.title}`,
    question.prompt,
    "",
    "ANSWER UNDER ASSESSMENT:",
    answer,
    "",
    "BUNDLE (full text of every document):",
    bundle,
  ].join("\n");
}

async function main() {
  const rubric: Rubric = JSON.parse(fs.readFileSync(path.join(BENCH_DIR, "rubric.json"), "utf-8"));
  const q = JSON.parse(fs.readFileSync(path.join(BENCH_DIR, "questions.json"), "utf-8"));
  const answersDir = path.join(BENCH_DIR, "answers", arg("answers") || "");
  if (!arg("answers") || !fs.existsSync(answersDir)) throw new Error("--answers <folder under benchmarks/<slug>/answers> is required");
  const only = arg("only");

  const orgArg = arg("org") || "";
  const org = await prisma.organization.findFirst({ where: { OR: [{ slug: orgArg }, { id: orgArg }] } });
  if (!org) throw new Error("--org <slug|id> is required");
  const caseRow = await prisma.case.findFirst({ where: { organizationId: org.id, caseName: q.caseName } });
  if (!caseRow) throw new Error("Benchmark case not seeded");
  const bundle = await bundleText(caseRow.id);
  console.log(`bundle text: ${bundle.length} chars; grader: ${MODEL}`);

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 600_000, maxRetries: 1 });
  const maxTotal = rubric.criteria.reduce((n, c) => n + c.weight, 0);
  const scorecard: any = { benchmark: BENCH_SLUG, answers: path.basename(answersDir), gradedAt: new Date().toISOString(), grader: MODEL, rubricVersion: rubric.version, moderated: false, questions: [] as any[] };

  for (const item of q.questions) {
    if (only && item.id !== only) continue;
    const answerPath = path.join(answersDir, `${item.id}.md`);
    if (!fs.existsSync(answerPath)) {
      console.warn(`${item.id}: no answer file, skipping`);
      continue;
    }
    const answer = fs.readFileSync(answerPath, "utf-8");
    process.stdout.write(`grading ${item.id} (${answer.length} chars)… `);
    const t0 = Date.now();
    const res = await client.responses.create({
      model: MODEL,
      reasoning: { effort: "high" },
      input: [{ role: "user", content: gradingPrompt(rubric, q.markingGuidance ?? [], item, answer, bundle) }],
    });
    const raw = (res.output_text || "").trim();
    let parsed: { scores: CriterionScore[]; overall_comment: string };
    try {
      parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    } catch {
      throw new Error(`${item.id}: grader did not return JSON:\n${raw.slice(0, 500)}`);
    }
    const byId = new Map(parsed.scores.map((s) => [s.id, s]));
    const scores = rubric.criteria.map((c) => {
      const s = byId.get(c.id);
      const score = Math.max(0, Math.min(c.weight, Math.round(s?.score ?? 0)));
      return { id: c.id, name: c.name, max: c.weight, score, justification: s?.justification ?? "", evidence: s?.evidence ?? [] };
    });
    const total = scores.reduce((n, s) => n + s.score, 0);
    scorecard.questions.push({ id: item.id, title: item.title, total, max: maxTotal, scores, overallComment: parsed.overall_comment, gradingSeconds: Math.round((Date.now() - t0) / 1000) });
    console.log(`${total}/${maxTotal} (${Math.round((Date.now() - t0) / 1000)}s)`);
  }

  const totals = scorecard.questions.map((x: any) => x.total);
  scorecard.overall = totals.length ? Math.round((totals.reduce((a: number, b: number) => a + b, 0) / totals.length) * 10) / 10 : null;
  scorecard.passMark = rubric.passMark;
  fs.writeFileSync(path.join(answersDir, "scorecard.json"), JSON.stringify(scorecard, null, 2));

  // Moderation sheet for a solicitor: one row per criterion per question, AI score pre-filled.
  const mod: string[] = [
    `# Moderation — ${BENCH_SLUG} — ${path.basename(answersDir)}`,
    "",
    `AI grader: ${MODEL}. Overall (AI): **${scorecard.overall} / ${maxTotal}**. Fill the "Moderated" column and sign at the bottom; leave a cell blank to accept the AI score.`,
    "",
  ];
  for (const qq of scorecard.questions) {
    mod.push(`## ${qq.id} — ${qq.title} — AI total ${qq.total}/${qq.max}`, "", "| Criterion | Max | AI | Moderated | Note |", "|---|---:|---:|---:|---|");
    for (const s of qq.scores) mod.push(`| ${s.id} · ${s.name} | ${s.max} | ${s.score} |  |  |`);
    mod.push("", `AI comment: ${qq.overallComment}`, "");
    for (const s of qq.scores) mod.push(`- **${s.id}** ${s.justification}${s.evidence.length ? ` _(${s.evidence.slice(0, 3).join("; ")})_` : ""}`);
    mod.push("");
  }
  mod.push("---", "Moderated by: ____________________   Date: __________   Moderated overall: ______ / 100", "");
  fs.writeFileSync(path.join(answersDir, "moderation.md"), mod.join("\n"));

  const scoresPath = path.resolve(__dirname, "..", "benchmarks", "scores.md");
  if (!fs.existsSync(scoresPath)) fs.writeFileSync(scoresPath, "# Benchmark score history\n\n| Date | Benchmark | Answers | Overall | Per question | Grader | Moderated |\n|---|---|---|---:|---|---|---|\n");
  fs.appendFileSync(
    scoresPath,
    `| ${scorecard.gradedAt.slice(0, 10)} | ${BENCH_SLUG} | ${path.basename(answersDir)} | ${scorecard.overall} | ${scorecard.questions.map((x: any) => `${x.id} ${x.total}`).join(", ")} | ${MODEL} | no |\n`,
  );
  console.log(`\noverall ${scorecard.overall}/${maxTotal} (pass mark ${rubric.passMark}) → ${path.join(answersDir, "scorecard.json")}, moderation.md; scores.md updated`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
