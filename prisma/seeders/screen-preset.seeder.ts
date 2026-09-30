import prisma from "../../src/lib/prisma";
import { Prisma } from "@prisma/client";

// Ported 1:1 from apps/web/lib/terminal/screen-presets.ts's TWO_SCREEN_PRESETS/THREE_SCREEN_PRESETS
// — the frontend now fetches these from the DB instead of holding them as hardcoded arrays.
// Idempotent (upserts on id, the same stable slug the frontend used to hardcode), safe to re-run.
// userId is left absent (null): these are system presets, global to every user.
const SYSTEM_PRESETS = [
  {
    id: "trial-prep",
    labelKey: "presetTrialPrep",
    descriptionKey: "presetTrialPrepDesc",
    name: "Trial Prep",
    screens: [
      { arrangement: "columns", panelIds: ["command", "chat", "evidence", "procedure"] },
      { arrangement: "free", panelIds: ["law", "mindMap", "redTeam", "citationMap"] },
    ],
  },
  {
    id: "document-review",
    labelKey: "presetDocumentReview",
    descriptionKey: "presetDocumentReviewDesc",
    name: "Document Review",
    screens: [
      { arrangement: "free", panelIds: ["evidence", "contradictions", "command"] },
      { arrangement: "tabs", panelIds: ["witnesses", "damages", "procedure", "teamAudit"] },
    ],
  },
  {
    id: "research-deep-dive",
    labelKey: "presetResearchDeepDive",
    descriptionKey: "presetResearchDeepDiveDesc",
    name: "Research Deep-Dive",
    screens: [
      { arrangement: "free", panelIds: ["command", "chat", "law"] },
      {
        arrangement: "tabs",
        panelIds: ["citationMap", "redTeam", "legalIssues", "weaknesses", "strengths", "attackStrategy", "defenseStrategy", "theories"],
      },
    ],
  },
  {
    id: "client-intake",
    labelKey: "presetClientIntake",
    descriptionKey: "presetClientIntakeDesc",
    name: "Client Intake",
    screens: [
      { arrangement: "free", panelIds: ["command", "chat"] },
      { arrangement: "free", panelIds: ["evidence", "procedure"] },
    ],
  },
  {
    id: "witness-prep",
    labelKey: "presetWitnessPrep",
    descriptionKey: "presetWitnessPrepDesc",
    name: "Witness Prep",
    screens: [
      { arrangement: "free", panelIds: ["command", "chat", "witnesses"] },
      { arrangement: "tabs", panelIds: ["contradictions", "redTeam", "teamAudit"] },
    ],
  },
  {
    id: "client-reporting",
    labelKey: "presetClientReporting",
    descriptionKey: "presetClientReportingDesc",
    name: "Client Reporting",
    screens: [
      { arrangement: "free", panelIds: ["command", "chat"] },
      { arrangement: "free", panelIds: ["decisions", "mindMap"] },
    ],
  },
  {
    id: "full-workspace",
    labelKey: "presetFullWorkspace",
    descriptionKey: "presetFullWorkspaceDesc",
    name: "Full Workspace",
    screens: [
      { arrangement: "free", panelIds: ["command", "chat"] },
      { arrangement: "columns", panelIds: ["evidence", "contradictions", "witnesses"] },
      { arrangement: "tabs", panelIds: ["law", "procedure", "mindMap", "damages", "caseReconstruction", "theories", "decisions"] },
    ],
  },
  {
    id: "trial-day",
    labelKey: "presetTrialDay",
    descriptionKey: "presetTrialDayDesc",
    name: "Trial Day",
    screens: [
      { arrangement: "free", panelIds: ["command", "chat"] },
      { arrangement: "columns", panelIds: ["evidence", "witnesses", "contradictions"] },
      { arrangement: "tabs", panelIds: ["law", "redTeam", "attackStrategy", "defenseStrategy", "legalIssues", "weaknesses", "strengths"] },
    ],
  },
  {
    id: "strategy-session",
    labelKey: "presetStrategySession",
    descriptionKey: "presetStrategySessionDesc",
    name: "Strategy Session",
    screens: [
      { arrangement: "free", panelIds: ["command", "chat", "procedure"] },
      { arrangement: "columns", panelIds: ["mindMap", "redTeam", "theories", "decisions"] },
      { arrangement: "tabs", panelIds: ["law", "citationMap", "damages", "witnesses", "caseReconstruction", "audioOverview", "teamAudit"] },
    ],
  },
  {
    id: "motion-drafting",
    labelKey: "presetMotionDrafting",
    descriptionKey: "presetMotionDraftingDesc",
    name: "Motion Drafting",
    screens: [
      { arrangement: "free", panelIds: ["command", "chat", "procedure"] },
      { arrangement: "free", panelIds: ["law", "citationMap"] },
      { arrangement: "tabs", panelIds: ["decisions", "legalIssues", "theories"] },
    ],
  },
  {
    id: "settlement-prep",
    labelKey: "presetSettlementPrep",
    descriptionKey: "presetSettlementPrepDesc",
    name: "Settlement Prep",
    screens: [
      { arrangement: "free", panelIds: ["command", "chat", "damages"] },
      { arrangement: "free", panelIds: ["witnesses", "theories"] },
      { arrangement: "tabs", panelIds: ["decisions", "procedure", "teamAudit"] },
    ],
  },
  {
    id: "cross-exam-prep",
    labelKey: "presetCrossExamPrep",
    descriptionKey: "presetCrossExamPrepDesc",
    name: "Cross-Exam Prep",
    screens: [
      { arrangement: "free", panelIds: ["command", "chat"] },
      { arrangement: "columns", panelIds: ["witnesses", "contradictions"] },
      { arrangement: "tabs", panelIds: ["attackStrategy", "defenseStrategy", "redTeam"] },
    ],
  },
] as const;

export async function seedScreenPresets() {
  for (const preset of SYSTEM_PRESETS) {
    const data = {
      labelKey: preset.labelKey,
      descriptionKey: preset.descriptionKey,
      name: preset.name,
      screenCount: preset.screens.length,
      screens: preset.screens as unknown as Prisma.InputJsonValue,
    };
    await prisma.screenPreset.upsert({
      where: { id: preset.id },
      update: data,
      create: { id: preset.id, ...data },
    });
  }

  console.log(`Seeded screen presets: ${SYSTEM_PRESETS.map((p) => p.id).join(", ")}`);
}
