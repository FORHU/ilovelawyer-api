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
 *  5. legal issues, one checked authority (Wood v Capita, text from the National Archives) pinned to the
 *     issues that turn on contract wording, citation grounds and the strategy map; the legal issues and
 *     the map are retried up to three times because the model's reply is sometimes unusable. Needs the
 *     API deployed with the strategy-map parser fix (API #496) or the map step will keep failing;
 *  6. the case brief as PDF and Word, last, so it holds everything above.
 * `--only-rest` runs step 5 alone on an existing case.
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

// Each conversation asks which English authorities decide the point on the case's facts, so every
// answer names and links the cases and statutes. The facts come from the case's own documents.
const CONVERSATIONS: Record<string, string[]> = {
  "Warranty claims under the SPA": [
    "Which English authorities decide how a warranty in a share purchase agreement is construed, and how do they apply to Warranty 7.3 (Material Contracts) in Meridian's SPA?",
    "Which English authorities decide whether a seller has fairly disclosed against a warranty, and does the Disclosure Letter cover the Northbridge Coatings contract?",
    "Which English authorities decide whether a notice of warranty claim is valid, and does Meridian's notice satisfy clause 11.8 of the SPA?",
    "Which English authorities decide the effect of the sellers' knowledge on a warranty claim, and what do the emails show about what Hale Specialty knew?",
  ],
  "Misrepresentation and concealment": [
    "Which English authorities decide when a failure to disclose becomes fraudulent misrepresentation, and could the 'close to chest' email support that claim?",
    "Which English statute and cases govern an exclusion or limitation of liability for misrepresentation, and can the sellers rely on the SPA's limits here?",
    "Which English authorities decide whether a party must correct an earlier statement that became untrue before completion, and what do the pre-completion meeting minutes record?",
    "Which English authorities decide how a tribunal weighs witness evidence against contemporaneous documents, and where do the Nandakumar and Ashworth-Hale statements conflict?",
  ],
  "Damages and limits on liability": [
    "Which English authorities decide how damages for breach of warranty in a share sale are measured, and how do the two expert reports in this case differ on that measure?",
    "Which English authorities decide how caps, thresholds and time limits in an SPA are construed, and which of those limits could reduce Meridian's recovery?",
    "Which English authorities decide the recoverability of loss of a key customer contract, and how does that apply to the Northbridge non-renewal?",
    "Which English authorities decide the strongest and weakest points on each side of a warranty dispute like this one?",
  ],
  "Procedure and next steps": [
    "Which English authorities decide the powers of an LCIA tribunal on documents and timetable, and what should Meridian do about its overdue document?",
    "Which English authorities decide whether a deadline extension or relief from a procedural default will be granted, and how do they apply here?",
    "Which English authorities decide the consequences of non-compliance with a tribunal's directions, including costs?",
    "Which English authorities should Meridian rely on to strengthen its claim before the hearing, and what evidence should it gather?",
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
    // POSTs always carry a JSON body, as the app's own requests do; some controllers read req.body.
    body: body === undefined ? (method === "POST" ? "{}" : undefined) : JSON.stringify(body),
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

// A saved citation is an internal Library link (the pill); an unrewritten one is still the external URL.
const AUTHORITY_LINK = /\]\(((?:https?:\/\/(?:caselaw\.nationalarchives\.gov\.uk|www\.legislation\.gov\.uk)|[^)\s]*\/homepage\/library\/laws\/)[^)\s]*)\)/g;
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
  for (const c of existing.filter((c) => !((c.title ?? "") in CONVERSATIONS))) {
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
    await sleep(8_000);
    await waitForJobs(caseId);
  }
  for (const pane of EXTRA_PANES) {
    await signIn();
    const r = await call("POST", `/my-cases/${caseId}/${pane}`);
    log(`${pane}: ${r.status}${r.status >= 300 ? ` ${JSON.stringify(r.data)}` : ""}`);
    await sleep(8_000);
    await waitForJobs(caseId);
  }
  const failed = await prisma.aiGenerationJob.findMany({ where: { subjectId: caseId, status: { not: "DONE" } }, select: { kind: true, status: true, error: true } });
  failed.forEach((j) => log(`  job ${j.kind}: ${j.status} ${j.error ?? ""}`));
}


// The model's reply for these two is sometimes unusable (no legal issues, or a map that does not parse),
// so each is retried and only counted once the rows are really there.
async function regenerateUntil(caseId: string, label: string, run: () => Promise<{ status: number; data: unknown }>, saved: () => Promise<number>) {
  if ((await saved()) > 0) {
    log(`${label}: already there`);
    return;
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    await signIn();
    const r = await run();
    log(`${label}: ${r.status} (attempt ${attempt})`);
    await sleep(8_000);
    await waitForJobs(caseId);
    if ((await saved()) > 0) return;
  }
  throw new Error(`${label}: nothing was saved after 3 attempts`);
}

// The one authority the sample case cites, with the passage taken from its National Archives text, so
// Law & Precedent shows a real, checked authority pinned to the issues that turn on contract wording.
const WOOD_SLUG = "uksc/2017/24";
const WOOD_CITATION = "[2017] UKSC 24";
const WOOD_PASSAGES = [
  { para: "12", start: "This unitary exercise involves an iterative process", quote: "This unitary exercise involves an iterative process by which each suggested interpretation is checked against the provisions of the contract and its commercial consequences are investigated" },
  { para: "13", start: "Textualism and contextualism are not conflicting paradigms", quote: "Textualism and contextualism are not conflicting paradigms in a battle for exclusive occupation of the field of contractual interpretation" },
];
const WOOD_ISSUE_PATTERN = /fairly disclosed|Clause 9|Earn-Out/i;

async function seedAuthority(caseId: string) {
  if ((await prisma.caseAuthority.count({ where: { caseId } })) > 0) {
    log("authority: already there");
    return;
  }
  const res = await fetch(`https://caselaw.nationalarchives.gov.uk/${WOOD_SLUG}/data.html`, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`National Archives page for ${WOOD_CITATION}: ${res.status}`);
  const text = (await res.text()).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
  await signIn();
  for (const p of WOOD_PASSAGES) {
    const at = text.indexOf(p.start);
    if (at < 0) throw new Error(`${WOOD_CITATION} para ${p.para}: passage not found on the National Archives page`);
    const next = text.indexOf(" 13. ", at);
    const officialText = (p.para === "12" && next > 0 ? text.slice(at, next) : text.slice(at, at + 400)).trim();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = await call<{ status: string }>("POST", `/my-cases/${caseId}/citations`, { quotedText: p.quote, citedReference: WOOD_CITATION, officialText, pinpoint: `para ${p.para}` });
      log(`quote check ${WOOD_CITATION} para ${p.para}: ${r.status} ${r.data?.status ?? ""}`);
      if (r.status === 201 && r.data?.status === "VALID") break;
      if (attempt === 3) throw new Error(`quote check para ${p.para} did not come back VALID`);
    }
  }
  const issues = await prisma.caseFinding.findMany({ where: { caseId, category: "LEGAL_ISSUE" }, select: { id: true, label: true } });
  const pinned = issues.filter((i) => WOOD_ISSUE_PATTERN.test(i.label));
  if (pinned.length === 0) throw new Error("no legal issue to pin the authority to");
  for (const issue of pinned) {
    const r = await call("POST", `/my-cases/${caseId}/authorities`, {
      kind: "CASE",
      stance: "ON_POINT",
      title: "Wood v Capita Insurance Services Ltd",
      subtitle: "UK Supreme Court: how an SPA's wording is construed",
      citation: WOOD_CITATION,
      rationale: "Wording in a share purchase agreement is read as a unitary exercise: each suggested meaning is checked against the contract's provisions and its commercial consequences are investigated (para 12).",
      findingId: issue.id,
    });
    log(`authority pinned to "${issue.label.slice(0, 50)}...": ${r.status}`);
  }
}

async function generateRest(caseId: string) {
  await regenerateUntil(caseId, "legal issues", () => call("POST", `/my-cases/${caseId}/findings/regenerate`, { category: "LEGAL_ISSUE" }), () =>
    prisma.caseFinding.count({ where: { caseId, category: "LEGAL_ISSUE" } }),
  );
  await seedAuthority(caseId);
  await signIn();
  const g = await call("POST", `/my-cases/${caseId}/citation-grounds/map`);
  log(`citation grounds: ${g.status}${g.status >= 300 ? ` ${JSON.stringify(g.data)}` : ""}`);
  await sleep(8_000);
  await waitForJobs(caseId);
  await regenerateUntil(caseId, "strategy map", () => call("POST", `/my-cases/${caseId}/mind-map/generate`), () => prisma.caseMindMap.count({ where: { caseId } }));
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
  if (!process.argv.includes("--only-rest")) {
    await seedConversations(caseId);
    await generatePanes(caseId);
  }
  await generateRest(caseId);
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
