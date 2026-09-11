/**
 * Seed the Brackenmoor Wharf benchmark case (fictional test material) into a UK organization.
 *
 * Creates one Case, uploads benchmarks/brackenmoor/docs/D01–D20 to S3 through the same
 * CaseSvc.handleCreateCaseWithDocument path the UI's presign flow ends in (so extraction,
 * chunking and embeddings run through DocumentExtractionQueue exactly as for a user upload),
 * and opens one Consultation bound to the case so the D21 questions can be asked against it
 * from the app or from scripts/run-brackenmoor-benchmark.ts.
 *
 * Idempotent: re-running reuses the existing case (matched by caseName within the org) and
 * only uploads documents whose filename is not already attached. `--reset` deletes the
 * existing case first.
 *
 * Run (against whatever DATABASE_URL / AWS_* / SQS the .env points at):
 *   npx ts-node scripts/seed-brackenmoor-benchmark.ts --org my-practice
 *   npx ts-node scripts/seed-brackenmoor-benchmark.ts --org my-practice --user someone@example.com
 *   npx ts-node scripts/seed-brackenmoor-benchmark.ts --org my-practice --reset
 *
 * Extraction is asynchronous: an API process (local `npm run dev` or the deployed one sharing
 * the queue) must be running to drain DocumentExtractionQueue. The script prints the case id,
 * consultation id and per-document ragStatus; poll with `--status` until every doc is READY.
 */
import * as dotenv from "dotenv";
dotenv.config();

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

import prisma from "../src/lib/prisma";
import CaseSvc from "../src/services/case.service";
import ChatRepo from "../src/repositories/chat.repository";
import { uploadToS3 } from "../src/utils/s3";

const BENCH_DIR = path.resolve(__dirname, "..", "benchmarks", "brackenmoor");
const DOCS_DIR = path.join(BENCH_DIR, "docs");
const QUESTIONS_PATH = path.join(BENCH_DIR, "questions.json");

type Questions = {
  caseName: string;
  preamble: string;
  questions: { id: string; title: string; prompt: string }[];
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** Bundle doc label ("D07") and a category from the filename, e.g.
 *  D07_Interview_Under_Caution_Aldwyn_Ferris.pdf → { label: "D07", category: "Interview Under Caution Aldwyn Ferris" }. */
function describe(filename: string) {
  const m = /^(D\d{2})_(.+)\.pdf$/i.exec(filename);
  return {
    label: m ? m[1].toUpperCase() : filename,
    category: m ? m[2].replace(/_/g, " ") : "Bundle document",
  };
}

async function resolveOrgAndUser(orgArg: string | undefined, userEmail: string | undefined) {
  const org = await prisma.organization.findFirst({
    where: {
      tenant: { code: "UK" },
      ...(orgArg ? { OR: [{ slug: orgArg }, { id: orgArg }] } : {}),
    },
    include: {
      tenant: { select: { code: true } },
      members: { include: { user: { select: { id: true, email: true } } }, orderBy: { createdAt: "asc" } },
    },
    orderBy: { createdAt: "asc" },
  });
  if (!org) throw new Error(`No UK organization found${orgArg ? ` for --org ${orgArg}` : ""}`);

  let member = org.members.find((m) => m.status === "ACCEPTED");
  if (userEmail) {
    member = org.members.find((m) => m.user.email.toLowerCase() === userEmail.toLowerCase());
    if (!member) throw new Error(`${userEmail} is not a member of organization ${org.slug}`);
  }
  if (!member) throw new Error(`Organization ${org.slug} has no accepted members`);
  return { org, user: member.user };
}

async function printStatus(caseId: string) {
  const docs = await prisma.document.findMany({
    where: { caseId },
    select: { id: true, name: true, ragStatus: true, pageCount: true, _count: { select: { chunks: true } } },
    orderBy: { name: "asc" },
  });
  console.log(`\nDocuments on case ${caseId}:`);
  for (const d of docs) {
    console.log(`  ${d.ragStatus.padEnd(10)} ${String(d._count.chunks).padStart(4)} chunks  ${d.name}`);
  }
  const ready = docs.filter((d) => d.ragStatus === "READY").length;
  console.log(`  ${ready}/${docs.length} READY`);
  return docs;
}

async function main() {
  const questions: Questions = JSON.parse(fs.readFileSync(QUESTIONS_PATH, "utf-8"));
  const { org, user } = await resolveOrgAndUser(arg("org"), arg("user"));
  console.log(`Organization: ${org.name} (${org.slug}, tenant ${org.tenant.code})`);
  console.log(`User:         ${user.email}`);

  let existing = await prisma.case.findFirst({
    where: { organizationId: org.id, caseName: questions.caseName },
    select: { id: true },
  });

  if (flag("status")) {
    if (!existing) throw new Error("Benchmark case not seeded yet");
    await printStatus(existing.id);
    return;
  }

  if (existing && flag("reset")) {
    console.log(`Deleting existing case ${existing.id} (--reset)`);
    await CaseSvc.delete(existing.id, org.id);
    existing = null;
  }

  let caseId: string;
  if (existing) {
    caseId = existing.id;
    console.log(`Reusing existing case ${caseId}`);
  } else {
    const created = await CaseSvc.create(org.id, user.id, {
      caseName: questions.caseName,
      actionType: "Corporate manslaughter / HSWA prosecution; TCC payment & termination dispute; insurance coverage; ET protected disclosure; inquest",
      jurisdiction: "England & Wales — Crown Court (Leeds), TCC Leeds, Employment Tribunal Leeds, West Yorkshire (Eastern) Coroner",
      notes:
        "FICTIONAL TEST MATERIAL — NOT A REAL CASE. Brackenmoor Wharf benchmark bundle D01–D20.\n\n" +
        `Assessment (D21): ${questions.preamble}\n\n` +
        questions.questions.map((q) => `${q.id} — ${q.title}`).join("\n") +
        "\n\nFull question text: benchmarks/brackenmoor/questions.json",
      parties: [
        { name: "Meridian Structures Limited", designation: "Defendant (Crown Court) / Contractor (TCC)" },
        { name: "Aldwyn Sinclair Ferris", designation: "Defendant (Crown Court)" },
        { name: "Coldbrook Capital LLP", designation: "Employer / Claimant (TCC)" },
        { name: "Priya Raghunathan", designation: "Claimant (Employment Tribunal)" },
        { name: "Deniz Aksoy", designation: "Injured person / civil claimant" },
        { name: "Tomasz Wieczorek (deceased)", designation: "Deceased" },
        { name: "Caldera Specialty Insurance (UK) Limited", designation: "Insurer" },
      ],
    });
    caseId = created.id;
    console.log(`Created case ${caseId}`);
  }

  const attached = new Set(
    (await prisma.document.findMany({ where: { caseId }, select: { name: true } })).map((d) => d.name),
  );
  const files = fs
    .readdirSync(DOCS_DIR)
    .filter((f) => /^D\d{2}_.+\.pdf$/i.test(f))
    .sort();
  const toUpload = files.filter((f) => !attached.has(f));
  console.log(`${files.length} bundle documents; ${toUpload.length} to upload`);

  if (toUpload.length) {
    const documentData = [];
    for (const filename of toUpload) {
      const body = fs.readFileSync(path.join(DOCS_DIR, filename));
      // Same key shape DocumentSvc.presign() issues for case uploads.
      const key = `documents/cases/${caseId}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.pdf`;
      await uploadToS3(key, body, "application/pdf");
      const { label, category } = describe(filename);
      documentData.push({
        filename,
        s3Key: key,
        metaData: {
          documentType: "pdf",
          fileSize: body.length,
          mimeType: "application/pdf",
          category: `${label} — ${category}`,
        },
      });
      console.log(`  uploaded ${filename} (${body.length} bytes)`);
    }
    const created = await CaseSvc.handleCreateCaseWithDocument(
      { caseId, organizationId: org.id, userId: user.id },
      documentData,
    );
    console.log(`Attached ${created.length} documents; extraction enqueued`);
  }

  let consultation = await prisma.consultation.findFirst({
    where: { caseId, organizationId: org.id, title: "Brackenmoor Wharf Benchmark (D21)" },
    select: { id: true },
  });
  if (!consultation) {
    consultation = await ChatRepo.createConsultation(org.id, user.id, "Brackenmoor Wharf Benchmark (D21)", caseId);
    console.log(`Created consultation ${consultation.id}`);
  } else {
    console.log(`Reusing consultation ${consultation.id}`);
  }

  await printStatus(caseId);
  console.log(`\nCase id:         ${caseId}`);
  console.log(`Consultation id: ${consultation.id}`);
  console.log(`Questions:       ${QUESTIONS_PATH}`);
  console.log("Poll extraction: npx ts-node scripts/seed-brackenmoor-benchmark.ts --org " + org.slug + " --status");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
