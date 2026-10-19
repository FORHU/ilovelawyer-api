/**
 * Builds the shared, read-only sample case guests tour from the trial page (TRIAL_SAMPLE_CASE_ID),
 * complete: documents indexed, conversations answered with linked authorities, every Terminal pane
 * generated, and the stored case brief. Run once per environment, against that environment's
 * database (DATABASE_URL in .env) and its running API (which drains the queues and runs the AI).
 * Deploy Chat Wonder's UK related-cases fix first, or answers come back without case-law cards.
 *
 *   npx ts-node scripts/seed-sample-case.ts --api http://localhost:3001 --origin https://uk.ilovelawyer.com \
 *     --owner-email sample-case-owner@ilovelawyer.com --owner-password '<password>'
 *
 * Steps (each one is skipped when already done, so a re-run picks up where it stopped):
 *  1. the sample owner account (verified, approved, no free-credit limit) and its portfolio;
 *  2. the Meridian case and its 15 documents, through scripts/seed-benchmark.ts;
 *  3. four conversations of four questions, each asking for the governing authorities; an answer
 *     with no linked case law or legislation is reported;
 *  4. Refresh analysis, then red team, witnesses, damages, claims and timeline, waiting for every
 *     job on the case to finish;
 *  5. the case brief as PDF and Word, last, so it holds everything above.
 * Prints the case id to set as TRIAL_SAMPLE_CASE_ID. Spends real OpenAI money (about US$1.50).
 */
import { spawn } from "child_process";
import path from "path";
import bcrypt from "bcrypt";
import prisma from "../src/lib/prisma";
import AuthRepo from "../src/repositories/auth.repository";
import OrganizationSvc from "../src/services/organization.service";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const API = (arg("api") || "http://localhost:3001").replace(/\/$/, "") + "/api";
const ORIGIN = arg("origin") || "https://uk.ilovelawyer.com";
const OWNER_EMAIL = arg("owner-email") || "";
const OWNER_PASSWORD = arg("owner-password") || "";
const UK_TENANT_CODE = "UK";
const log = (m: string) => console.log(`${new Date().toTimeString().slice(0, 8)} ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CONVERSATIONS: Record<string, string[]> = {
  "Case overview and the warranty claim": [
    "Give me an overview of this dispute: who the parties are, what Meridian bought and what it claims. Then set out the English law on warranty claims under a share purchase agreement.",
    "Which warranties does Meridian say were breached, what does each require, and how do the English courts construe warranties like these?",
    "What did the Disclosure Letter disclose, and does it cover the Northbridge contract? Apply the English test for fair disclosure.",
    "Was the Notice of Warranty Claim valid? Apply the SPA's clauses and the English case law on notice-of-claim provisions.",
  ],
  "What Hale Specialty knew about Northbridge": [
    "Using the emails, when did Hale Specialty learn that Northbridge would not renew, and how does English law treat a seller's actual knowledge in a warranty claim?",
    "What does the internal 'close to chest' email show, and could it support a claim for fraudulent misrepresentation or deliberate concealment under English law?",
    "What do the minutes of the pre-completion management meeting record, and did the sellers have any duty to correct earlier statements before completion?",
    "Where do the witness statements of Priya Nandakumar and Julian Ashworth-Hale conflict, which account do the documents support, and how will an English tribunal weigh oral evidence against contemporaneous documents?",
  ],
  "Quantum, limits and next steps": [
    "How do the two expert reports differ on the loss from the Northbridge contract, and how do the English courts measure damages for breach of warranty in a share sale?",
    "Which limitations in the SPA (caps, thresholds, time limits) could reduce Meridian's recovery, and how do the English courts construe them?",
    "What are the strongest and weakest points for each side, with the legal authority behind each?",
    "What should Meridian do next before the hearing, including any procedural points under the LCIA Rules and English law?",
  ],
  "The law: disclosure, knowledge and remedies": [
    "Under English law, how do the courts decide whether a seller has fairly disclosed against a warranty in a share purchase agreement? Apply it to Meridian's Disclosure Letter.",
    "How does English law treat a seller who knew of a problem and kept it back: can the contractual limits on liability still apply, and when does it become fraudulent misrepresentation?",
    "How are damages for breach of warranty in a share sale measured under English law, and what does that mean for Meridian's claim?",
    "How strictly do the English courts read notice-of-claim clauses in share purchase agreements, and would Meridian's notice survive them?",
  ],
};
// Panes Refresh analysis doesn't run itself.
const EXTRA_PANES = ["red-team/generate", "witnesses/refresh", "damages/refresh", "claims/extract", "timeline/generate"];

let token = "";
let organizationId = "";
async function call<T = any>(method: string, route: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: {
      Origin: ORIGIN,
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(organizationId ? { "X-Organization-Id": organizationId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, data };
}
async function signIn() {
  const r = await call<{ accessToken: string }>("POST", "/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
  if (r.status !== 200) throw new Error(`Sign-in as the sample owner failed: ${r.status} ${JSON.stringify(r.data)}`);
  token = r.data.accessToken;
}

async function ensureOwner() {
  const tenant = await prisma.tenant.findUnique({ where: { code: UK_TENANT_CODE } });
  if (!tenant) throw new Error('No Tenant seeded for code "UK"');
  let user = await prisma.user.findUnique({ where: { email: OWNER_EMAIL.toLowerCase() } });
  if (!user) {
    user = await AuthRepo.createUser({
      username: `samplecase${Date.now().toString().slice(-6)}`,
      email: OWNER_EMAIL,
      password: bcrypt.hashSync(OWNER_PASSWORD, 10),
      name: "ilovelawyer Sample",
      // A lawyer-app account: the sample case lives in ilovelawyer-app, like the trial guests.
      role: "LAWYER",
      tenantId: tenant.id,
    });
    log(`created the sample owner ${OWNER_EMAIL}`);
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { role: "LAWYER", isEmailVerified: true, approvalStatus: "ACTIVE", onboardingCompleted: true, freeCreditUsd: null },
  });
  let portfolio = await prisma.organization.findFirst({ where: { createdById: user.id, isPersonal: true } });
  if (!portfolio) {
    await OrganizationSvc.create(user.id, "ilovelawyer Sample", undefined, UK_TENANT_CODE, true);
    portfolio = await prisma.organization.findFirst({ where: { createdById: user.id, isPersonal: true } });
  }
  if (!portfolio) throw new Error("Could not create the sample owner's portfolio");
  return { userId: user.id, portfolio };
}

async function seedCase(portfolioSlug: string): Promise<string> {
  // seed-benchmark never exits on its own (its Redis connection keeps it alive), so read its output
  // until it prints the case id, then stop it. The documents keep indexing in the API's queue.
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [require.resolve("ts-node/dist/bin.js"), path.join(__dirname, "seed-benchmark.ts"), "--bench", "meridian", "--org", portfolioSlug, "--user", OWNER_EMAIL],
      { env: { ...process.env, TS_NODE_TRANSPILE_ONLY: "true" } },
    );
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`seed-benchmark printed no case id within 10 minutes:
${out.slice(-2000)}`));
    }, 10 * 60 * 1000);
    const onData = (chunk: Buffer) => {
      out += chunk.toString();
      const caseId = /Case id:\s+([0-9a-f-]{36})/.exec(out)?.[1];
      if (caseId) {
        clearTimeout(timer);
        child.kill();
        resolve(caseId);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (c: Buffer) => (out += c.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function waitForDocuments(caseId: string) {
  for (let i = 0; i < 180; i++) {
    const docs = await prisma.document.findMany({ where: { caseId }, select: { ragStatus: true } });
    const ready = docs.filter((d) => d.ragStatus === "READY").length;
    const failed = docs.filter((d) => d.ragStatus === "FAILED").length;
    if (docs.length && ready + failed === docs.length) {
      log(`documents: ${ready} ready, ${failed} failed`);
      return;
    }
    if (i % 6 === 0) log(`documents: ${ready}/${docs.length} ready`);
    await sleep(10_000);
  }
  throw new Error("Documents still indexing after 30 minutes (is the API running to drain the extraction queue?)");
}

async function waitForReply(consultationId: string) {
  for (let i = 0; i < 240; i++) {
    await sleep(5_000);
    const last = await prisma.message.findFirst({
      where: { consultationId, role: "user" },
      orderBy: { createdAt: "desc" },
      select: { replyStatus: true },
    });
    if (last?.replyStatus === "DONE" || last?.replyStatus === "FAILED") return last.replyStatus;
  }
  return "TIMED OUT";
}

const AUTHORITY_LINK = /\]\((https?:\/\/(?:caselaw\.nationalarchives\.gov\.uk|www\.legislation\.gov\.uk)[^)\s]*)\)/g;
async function linkedAuthoritiesInLastAnswer(consultationId: string): Promise<number> {
  const r = await call("GET", `/chat/consultations/${consultationId}/messages`);
  const text = JSON.stringify(r.data);
  const parent = await prisma.message.findFirst({ where: { consultationId, role: "user" }, orderBy: { createdAt: "desc" }, select: { id: true } });
  // Only the newest turn: the slice of the payload after the newest question's id.
  const at = parent ? text.lastIndexOf(parent.id) : -1;
  return new Set([...(at > -1 ? text.slice(at) : text).matchAll(AUTHORITY_LINK)].map((m) => m[1])).size;
}

async function seedConversations(caseId: string) {
  const existing = await prisma.consultation.findMany({ where: { caseId, status: "ACTIVE" }, select: { id: true, title: true } });
  for (const [title, questions] of Object.entries(CONVERSATIONS)) {
    let consultationId = existing.find((c) => c.title === title)?.id;
    const asked = consultationId ? await prisma.message.count({ where: { consultationId, role: "user", replyStatus: "DONE" } }) : 0;
    if (asked >= questions.length) {
      log(`conversation "${title}": already answered`);
      continue;
    }
    await signIn();
    if (!consultationId) {
      const created = await call<{ id: string }>("POST", "/chat/consultations", { title, caseId });
      if (created.status !== 201) throw new Error(`Creating "${title}" failed: ${created.status} ${JSON.stringify(created.data)}`);
      consultationId = created.data.id;
    }
    log(`conversation "${title}" (${consultationId})`);
    for (const question of questions.slice(asked)) {
      await signIn();
      const session = (await call<{ session_id: string }>("GET", "/chat/session")).data.session_id;
      const sent = await call("POST", `/chat/consultations/${consultationId}/messages`, { message: question, sessionId: session });
      if (sent.status >= 300) throw new Error(`Sending failed: ${sent.status} ${JSON.stringify(sent.data)}`);
      const status = await waitForReply(consultationId);
      await signIn();
      const links = await linkedAuthoritiesInLastAnswer(consultationId);
      log(`  ${status}, ${links} linked authorities${links ? "" : "  <-- NO LINKED AUTHORITIES"}: ${question.slice(0, 70)}...`);
    }
  }
  // The seeder's own empty benchmark consultation is not part of the tour.
  for (const c of existing.filter((c) => !(c.title in CONVERSATIONS))) {
    await signIn();
    await call("POST", `/chat/consultations/${c.id}/archive`);
    await call("DELETE", `/chat/consultations/${c.id}`);
    log(`removed the extra conversation "${c.title}"`);
  }
}

async function waitForJobs(caseId: string) {
  for (let i = 0; i < 270; i++) {
    const running = await prisma.aiGenerationJob.findMany({ where: { subjectId: caseId, status: "IN_PROGRESS" }, select: { kind: true } });
    if (!running.length) return;
    if (i % 6 === 0) log(`  still running: ${running.map((r) => r.kind).join(", ")}`);
    await sleep(10_000);
  }
  throw new Error("Case jobs still running after 45 minutes");
}

async function generatePanes(caseId: string) {
  if (await prisma.aiGenerationJob.findFirst({ where: { subjectId: caseId, kind: "caseRefresh", status: "DONE" } })) {
    log("Refresh analysis: already done");
  } else {
    await signIn();
    const r = await call("POST", `/my-cases/${caseId}/refresh`);
    log(`Refresh analysis: ${r.status}`);
    await sleep(5_000);
    await waitForJobs(caseId);
  }
  for (const pane of EXTRA_PANES) {
    await signIn();
    const r = await call("POST", `/my-cases/${caseId}/${pane}`);
    log(`${pane}: ${r.status}${r.status >= 300 ? ` ${JSON.stringify(r.data)}` : ""}`);
    await sleep(3_000);
    await waitForJobs(caseId);
  }
  const failed = await prisma.aiGenerationJob.findMany({ where: { subjectId: caseId, status: { not: "DONE" } }, select: { kind: true, status: true, error: true } });
  failed.forEach((j) => log(`  job ${j.kind}: ${j.status} ${j.error ?? ""}`));
}

async function generateBrief(caseId: string) {
  await waitForJobs(caseId);
  await signIn();
  for (const format of ["pdf", "docx"]) {
    const r = await call<{ file: { id: string } }>("GET", `/my-cases/${caseId}/export?format=${format}`);
    log(`case brief ${format}: ${r.status === 200 ? `file ${r.data.file.id}` : `${r.status} ${JSON.stringify(r.data)}`}`);
  }
}

async function main() {
  if (!OWNER_EMAIL || !OWNER_PASSWORD) throw new Error("--owner-email and --owner-password are required");
  const { portfolio } = await ensureOwner();
  log(`sample owner portfolio: ${portfolio.slug} (${portfolio.id})`);
  await signIn();
  organizationId = portfolio.id;
  const existingCase = await prisma.case.findFirst({ where: { organizationId: portfolio.id, caseName: { contains: "Meridian" } }, select: { id: true } });
  const caseId = existingCase?.id ?? (await seedCase(portfolio.slug!));
  log(`sample case: ${caseId}`);
  await waitForDocuments(caseId);
  await seedConversations(caseId);
  await generatePanes(caseId);
  await generateBrief(caseId);
  log(`done. Set TRIAL_SAMPLE_CASE_ID=${caseId}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    // The services it loads open a Redis connection that would keep it running.
    process.exit();
  });
