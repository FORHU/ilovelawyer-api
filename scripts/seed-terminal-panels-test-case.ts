/**
 * Local test case for the Legal Terminal's Legal Issues, Weaknesses, Strengths and Citation Map
 * panels — the design catalog's own example, Reyes v. Northbridge Logistics (NLRC NCR, illegal
 * dismissal). Every panel state is covered without Chat Wonder or Jev: rows carry sample Jev
 * checks, so the flags, pills, impact markers and "Checked by Jev" blocks all render.
 *
 *   npx ts-node scripts/seed-terminal-panels-test-case.ts            # create (or reuse) the case
 *   npx ts-node scripts/seed-terminal-panels-test-case.ts --reset    # delete it and start over
 *
 * Needs the API running on PORT (it logs in as SEED_ADMIN_EMAIL/PASSWORD and creates the
 * organization and case through the API, so every access rule holds), and the database migrated.
 * Everything else is written straight to the database. Local development only — never point this
 * at a shared database. The "later decision" law rows are made up and titled TEST so they can't be
 * mistaken for real authority.
 */
import * as dotenv from "dotenv";
dotenv.config();
import prisma from "../src/lib/prisma";
import CaseGraphSvc from "../src/services/case-graph.service";

const API = `http://localhost:${process.env.PORT || 3001}/api`;
const ORIGIN = "http://ph.ilovelawyer.local:3002";
const ORG_NAME = "Terminal Panels Test (PH)";
const CASE_NAME = "Reyes v. Northbridge Logistics (panel test)";
const TEST_LAW_PREFIX = "test-terminal-panels-";

async function api<T>(path: string, init: RequestInit & { token?: string; orgId?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json", origin: ORIGIN };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.orgId) headers["x-organization-id"] = init.orgId;
  const res = await fetch(`${API}${path}`, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${JSON.stringify(body)}`);
  return body as T;
}

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed test data with NODE_ENV=production.");
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password) throw new Error("SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must be set in .env.");

  const { accessToken: token } = await api<{ accessToken: string }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });

  // One organization per user (OrganizationMember.userId is unique): reuse the admin's if it has one.
  const orgs = await api<{ id: string; name: string }[]>("/organizations", { token });
  const org = orgs[0] ?? (await api<{ id: string; name: string }>("/organizations", { method: "POST", token, body: JSON.stringify({ name: ORG_NAME }) }));

  const existing = await prisma.case.findFirst({ where: { organizationId: org.id, caseName: CASE_NAME } });
  if (existing && process.argv.includes("--reset")) {
    await prisma.case.delete({ where: { id: existing.id } });
    console.log(`Deleted the previous test case ${existing.id}.`);
  } else if (existing) {
    console.log(`Test case already exists — pass --reset to rebuild it.\nOpen: ${ORIGIN}/homepage/terminal/${existing.id}`);
    return;
  }

  const created = await api<{ id: string }>("/my-cases", {
    method: "POST",
    token,
    orgId: org.id,
    body: JSON.stringify({
      caseName: CASE_NAME,
      actionType: "Labor Dispute",
      jurisdiction: "NLRC NCR, No. 2026-0412",
      parties: [
        { name: "Maria Reyes", designation: "Petitioner / Plaintiff" },
        { name: "Northbridge Logistics, Inc.", designation: "Respondent / Defendant" },
      ],
    }),
  });
  const caseId = created.id;
  const now = new Date();

  // ── Legal Issues ── one per state: Jev-contested with a model disagreement, a burden dispute,
  // a lawyer-entered row with no check (shows "Check with Jev"), resolved, and a legacy untagged row.
  const issues = [
    {
      label: "Was the abandonment claim substantiated?",
      detail: "Employer bears the burden of proving just cause",
      tag: "CONTESTED",
      modelTag: "OPEN",
      notes: "AI",
      sourceLabel: "Termination letter (NBL-HR-000912)",
      jev: { raised: "RAISED", raisedConfidence: 0.94, contested: "CONTESTED", contestedConfidence: 0.88, burden: "RESPONDENT", burdenConfidence: 0.91, modelBurden: "RESPONDENT", flags: [], uncertain: false },
    },
    {
      label: "Was the twin-notice requirement met?",
      detail: "Complainant must show no notice to explain was served",
      tag: "OPEN",
      notes: "AI",
      jev: { raised: "RAISED", raisedConfidence: 0.9, contested: "UNCONTESTED", contestedConfidence: 0.62, burden: "RESPONDENT", burdenConfidence: 0.83, modelBurden: "CLAIMANT", flags: ["BURDEN_DISPUTED"], uncertain: false },
    },
    { label: "Does the 14-day gap show retaliation?", detail: "Complaint 28 Jul, termination 11 Aug", tag: "BRIEFING", notes: null, jev: null },
    { label: "Is reinstatement still viable?", detail: "Strained relations not pleaded", tag: "RESOLVED", notes: null, jev: null },
    { label: "Are moral damages recoverable?", detail: null, tag: null, notes: null, jev: null },
  ];

  // ── Weaknesses ── Material with the soonest surfacing first, one not borne out (flag), one with
  // no fix on record, one closed.
  const weaknesses = [
    {
      label: "No written protest between 4 and 11 Aug",
      detail: "Notice posture depends on the complaint",
      tag: "MATERIAL",
      modelTag: "MINOR",
      impact: 8,
      notes: "AI",
      jev: { support: "SUPPORTED", supportConfidence: 0.9, severity: 0.84, severityConfidence: 0.8, surfacing: 1, surfacingConfidence: 0.85, curable: "NOT_CURABLE", curableConfidence: 0.74, flags: [], uncertain: false },
    },
    {
      label: "R. Santos statement outstanding",
      detail: "Obtain the shift supervisor's statement on attendance 4–8 Aug",
      tag: "MATERIAL",
      impact: 7,
      notes: "AI",
      jev: { support: "SUPPORTED", supportConfidence: 0.86, severity: 0.67, severityConfidence: 0.71, surfacing: 0.67, surfacingConfidence: 0.7, curable: "BY_EVIDENCE", curableConfidence: 0.9, flags: [], uncertain: false },
    },
    {
      label: "Client signed a quitclaim",
      detail: "Check whether one exists",
      tag: "MINOR",
      impact: 0,
      notes: "AI",
      jev: { support: "UNSUPPORTED", supportConfidence: 0.81, severity: 0.9, severityConfidence: 0.45, surfacing: 0.33, surfacingConfidence: 0.6, curable: "BY_ARGUMENT", curableConfidence: 0.7, flags: ["NOT_BORNE_OUT"], uncertain: true },
    },
    { label: "Payroll certification not obtained", detail: "Needed before the position paper", tag: "CLOSED", impact: 4, notes: null, jev: null },
  ];

  // ── Strengths ── strong with its document reference, one checked without the source text, one
  // its source doesn't bear out (struck-through reference).
  const strengths = [
    {
      label: "Attendance logged through 8 August",
      detail: "NBL-PR-000015 — present 4–8 Aug",
      tag: "STRONG",
      impact: 10,
      notes: "AI",
      sourceLabel: "Payroll register (NBL-PR-000015)",
      jev: { support: "SUPPORTED", supportConfidence: 0.93, sourceRead: true, weight: 1, weightConfidence: 0.84, rebuttal: "UNREBUTTED", rebuttalConfidence: 0.8, flags: [], uncertain: false },
    },
    {
      label: "HR's own 6 August email",
      detail: "NBL-EM-004417 — presumes continuing employment",
      tag: "STRONG",
      modelTag: "MODERATE",
      impact: 7,
      notes: "AI",
      sourceLabel: "HR email (NBL-EM-004417)",
      jev: { support: "SUPPORTED", supportConfidence: 0.78, sourceRead: false, weight: 0.67, weightConfidence: 0.7, rebuttal: "REBUTTABLE", rebuttalConfidence: 0.66, flags: [], uncertain: false },
    },
    {
      label: "Supervisor praised her attendance",
      detail: "Performance review, p. 2",
      tag: "MODERATE",
      impact: 0,
      notes: "AI",
      sourceLabel: "Performance review 2025",
      jev: { support: "UNSUPPORTED", supportConfidence: 0.8, sourceRead: true, weight: 0.33, weightConfidence: 0.4, rebuttal: "REBUTTABLE", rebuttalConfidence: 0.7, flags: ["NOT_BORNE_OUT"], uncertain: true },
    },
  ];

  const findingRows = [
    ...issues.map((f, i) => ({ category: "LEGAL_ISSUE" as const, position: i, ...f })),
    ...weaknesses.map((f, i) => ({ category: "WEAKNESS" as const, position: i, ...f })),
    ...strengths.map((f, i) => ({ category: "STRENGTH" as const, position: i, ...f })),
  ];
  for (const f of findingRows) {
    const row = await prisma.caseFinding.create({
      data: {
        caseId,
        category: f.category,
        label: f.label,
        detail: f.detail,
        tag: f.tag as any,
        modelTag: ("modelTag" in f ? f.modelTag : null) as any,
        impact: "impact" in f ? f.impact : null,
        position: f.position,
        notes: f.notes,
        sourceLabel: "sourceLabel" in f ? f.sourceLabel : null,
        jev: f.jev ?? undefined,
        jevCheckedAt: f.jev ? now : null,
      },
    });
    await CaseGraphSvc.ensureNode(caseId, "FINDING", row.id);
  }

  // ── Citation Map ── claims, authorities (three resolved into TEST law rows), links in every state.
  const tenant = await prisma.tenant.findUnique({ where: { code: "PH" } });
  if (!tenant) throw new Error('No Tenant row for "PH" — run the Prisma seed first.');
  const law = (key: string, category: "JURISPRUDENCE" | "REPUBLIC_ACT", title: string, caseNumber: string | null) =>
    prisma.law.upsert({
      where: { jurisSourceId: `${TEST_LAW_PREFIX}${key}` },
      update: {},
      create: { jurisSourceId: `${TEST_LAW_PREFIX}${key}`, category, tenantId: tenant.id, title, caseNumber, jurisUrl: `https://example.invalid/${key}`, rawJson: {} },
    });
  const art297 = await law("art-297", "REPUBLIC_ACT", "Labor Code, Art. 297 — Termination by employer", null);
  const agabon = await law("agabon", "JURISPRUDENCE", "Agabon v. NLRC", "G.R. No. 158693");
  const abbott = await law("abbott", "JURISPRUDENCE", "Abbott Laboratories v. Alcaraz", "G.R. No. 192571");
  const later = await law("later", "JURISPRUDENCE", "TEST — Later decision (made-up test data)", "TEST-0001");
  // The sweep finds these: Agabon ABANDONED (suggested as a weakness), Abbott DISTINGUISHED (not).
  await prisma.citationEdge.deleteMany({ where: { fromLawId: later.id } });
  await prisma.citationEdge.createMany({
    data: [
      { fromLawId: later.id, toLawId: agabon.id, treatment: "ABANDONED", excerpt: "(Test data) The Court abandons the rule in Agabon on the effect of a missing notice." },
      { fromLawId: later.id, toLawId: abbott.id, treatment: "DISTINGUISHED", excerpt: "(Test data) Abbott is distinguished — it concerned a probationary employee." },
    ],
  });

  const check = (citedReference: string, quotedText: string, extra: Record<string, unknown> = {}) =>
    prisma.citationCheck.create({ data: { caseId, citedReference, quotedText, status: "VALID", ...extra } });
  const cArt = await check("Labor Code, Art. 297", "An employer may terminate an employment for any of the following causes", { resolvedLawId: art297.id, resolutionConfidence: 0.95 });
  const cAgabon = await check("Agabon v. NLRC, G.R. No. 158693", "the employer must give the employee two written notices", { resolvedLawId: agabon.id, resolutionConfidence: 0.92 });
  const cAbbott = await check("Abbott Laboratories v. Alcaraz, G.R. No. 192571", "procedural compliance is required even for probationary employees", { resolvedLawId: abbott.id, resolutionConfidence: 0.9 });
  // The case's own check marked this one ADVERSE — the sweep always suggests it.
  await check("King of Kings Transport v. Mamac, G.R. No. 166208", "the notice must state the specific causes", {
    status: "ADVERSE",
    notes: "Official text appears to undermine this citation (test data).",
  });
  await check("Sample unmapped authority", "an authority no claim has been linked to yet");

  const claim = async (title: string, causeOfAction: string | null, ai: boolean) => {
    const row = await prisma.caseClaim.create({
      data: {
        caseId,
        title,
        causeOfAction,
        source: ai ? "AI" : "MANUAL",
        sourceLabel: ai ? "Complaint (NLRC NCR 2026-0412)" : null,
        sourceQuote: ai ? "Complainant alleges that she was illegally dismissed without just cause" : null,
      },
    });
    await CaseGraphSvc.ensureNode(caseId, "CLAIM", row.id);
    return row;
  };
  const dismissal = await claim("Illegal dismissal", "Labor Code, Art. 294", true);
  const dueProcess = await claim("Denial of procedural due process", "Twin-notice rule", true);
  const wages = await claim("Unpaid wages", null, false);

  await prisma.citationGround.createMany({
    data: [
      { caseId, citationCheckId: cArt.id, claimId: dismissal.id, role: "SUBSTANTIVE", source: "AI", reason: "States the just causes the employer must prove", jev: { attaches: "SUPPORTS_GROUND", confidence: 0.92 }, jevCheckedAt: now },
      { caseId, citationCheckId: cAgabon.id, claimId: dueProcess.id, role: "PROCEDURAL", source: "AI", reason: "Sets out the two-notice requirement", jev: { attaches: "TANGENTIAL", confidence: 0.64 }, jevCheckedAt: now },
      { caseId, citationCheckId: cAbbott.id, claimId: wages.id, role: "SUBSTANTIVE", source: "MANUAL", jev: { attaches: "DOES_NOT_APPLY", confidence: 0.83 }, jevCheckedAt: now },
    ],
  });

  console.log(`Created test case ${caseId} in organization "${org.name}".`);
  console.log(`Open: ${ORIGIN}/homepage/terminal/${caseId}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
