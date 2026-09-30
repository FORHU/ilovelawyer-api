import prisma from "../../src/lib/prisma";
import { Prisma } from "@prisma/client";

// screenCount: 1 presets replace the old New Layout dialog's hardcoded PresetValue picker
// (PANE_1/2/4/6, formerly applyPreset/PresetLayoutPreview in legal-terminal.tsx) — same panel
// sets, workflow-named instead of "N panes".
// Idempotent (upserts on id, the same stable slug the frontend used to hardcode), safe to re-run.
// userId is left absent (null): these are system presets, global to every user.
const SYSTEM_PRESETS = [
  {
    id: "pane-1",
    labelKey: "presetQuickReview",
    descriptionKey: "presetQuickReviewDesc",
    name: "Quick Review",
    screens: [{ arrangement: "free", panelIds: ["command"] }],
  },
  {
    id: "pane-2",
    labelKey: "presetEvidenceCheck",
    descriptionKey: "presetEvidenceCheckDesc",
    name: "Evidence Check",
    screens: [{ arrangement: "free", panelIds: ["command", "evidence"] }],
  },
  {
    id: "pane-4",
    labelKey: "presetCaseWorkspace",
    descriptionKey: "presetCaseWorkspaceDesc",
    name: "Case Workspace",
    screens: [{ arrangement: "free", panelIds: ["command", "evidence", "chat", "procedure"] }],
  },
  {
    id: "pane-6",
    labelKey: "presetFullResearch",
    descriptionKey: "presetFullResearchDesc",
    name: "Full Research",
    screens: [{ arrangement: "free", panelIds: ["command", "evidence", "law", "mindMap", "procedure", "chat"] }],
  },
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
  {
    id: "war-room",
    labelKey: "presetWarRoom",
    descriptionKey: "presetWarRoomDesc",
    name: "War Room",
    screens: [
      { arrangement: "free", panelIds: ["command", "chat"] },
      { arrangement: "columns", panelIds: ["evidence", "witnesses", "contradictions"] },
      { arrangement: "tabs", panelIds: ["law", "redTeam", "attackStrategy", "defenseStrategy"] },
      { arrangement: "tabs", panelIds: ["damages", "theories", "decisions", "procedure"] },
    ],
  },
  {
    id: "complex-litigation",
    labelKey: "presetComplexLitigation",
    descriptionKey: "presetComplexLitigationDesc",
    name: "Complex Litigation",
    screens: [
      { arrangement: "free", panelIds: ["command", "chat"] },
      { arrangement: "free", panelIds: ["evidence", "procedure"] },
      { arrangement: "columns", panelIds: ["law", "citationMap", "legalIssues"] },
      { arrangement: "tabs", panelIds: ["strengths", "weaknesses", "theories", "decisions"] },
    ],
  },
  {
    id: "full-team-audit",
    labelKey: "presetFullTeamAudit",
    descriptionKey: "presetFullTeamAuditDesc",
    name: "Full Team Audit",
    screens: [
      { arrangement: "free", panelIds: ["command", "chat"] },
      { arrangement: "columns", panelIds: ["witnesses", "contradictions", "teamAudit"] },
      { arrangement: "tabs", panelIds: ["law", "redTeam", "legalIssues", "weaknesses", "strengths"] },
      { arrangement: "tabs", panelIds: ["damages", "caseReconstruction", "decisions", "theories", "audioOverview"] },
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
