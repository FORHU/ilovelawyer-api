import prisma from "../../src/lib/prisma";
import { Prisma } from "@prisma/client";
import { panelGroupRank, type ArrangementValue, type PanelId } from "../../src/constants";

// Every system screen preset (1-6 screens). The multi-screen ones are built so related panes (PANEL_GROUPS) share a screen instead
// of being scattered. Each preset is just its pane set + one arrangement per screen; which pane
// lands on which screen is derived by splitByGroup, so a group is only split across screens when
// it is bigger than a screen. The 1-screen presets are listed in SINGLE_SCREEN below.
// Idempotent (upserts on id). userId is left absent: system presets, global to every user.
const [F, C, T]: ArrangementValue[] = ["free", "columns", "tabs"];

const SOURCES: { id: string; name: string; arrangements: ArrangementValue[]; panes?: PanelId[]; by?: PanelId[][] }[] = [
  { id: "trial-prep", name: "Trial Prep", arrangements: [C, F], panes: ["command", "chat", "evidence", "procedure", "law", "mindMap", "redTeam"] },
  { id: "document-review", name: "Document Review", arrangements: [F, T], panes: ["evidence", "command", "witnesses", "damages", "procedure"] },
  { id: "research-deep-dive", name: "Research Deep-Dive", arrangements: [F, T], panes: ["command", "chat", "law", "redTeam", "legalIssues", "weaknesses", "strengths", "attackStrategy", "defenseStrategy", "theories", "trace"] },
  { id: "client-intake", name: "Client Intake", arrangements: [F, F], panes: ["command", "chat", "evidence", "procedure"] },
  { id: "witness-prep", name: "Witness Prep", arrangements: [F, T], panes: ["command", "chat", "witnesses", "evidence", "redTeam"] },
  { id: "client-reporting", name: "Client Reporting", arrangements: [F, F], panes: ["command", "chat", "decisions", "mindMap"] },
  { id: "deposition-day", name: "Deposition Day", arrangements: [F, T], panes: ["command", "chat", "witnesses", "evidence", "redTeam", "attackStrategy"] },
  { id: "discovery-review", name: "Discovery Review", arrangements: [F, T], panes: ["evidence", "procedure", "decisions"] },
  { id: "appeal-prep", name: "Appeal Prep", arrangements: [F, T], panes: ["command", "chat", "legalIssues", "law", "theories", "strengths", "weaknesses", "trace"] },
  { id: "mediation-session", name: "Mediation Session", arrangements: [F, F], panes: ["command", "chat", "damages", "theories", "decisions"] },
  { id: "full-workspace", name: "Full Workspace", arrangements: [F, C, T], panes: ["command", "chat", "evidence", "witnesses", "law", "procedure", "mindMap", "damages", "caseReconstruction", "theories", "decisions", "trace"] },
  { id: "trial-day", name: "Trial Day", arrangements: [F, C, T], panes: ["command", "chat", "evidence", "witnesses", "law", "redTeam", "attackStrategy", "defenseStrategy", "legalIssues", "weaknesses", "strengths"] },
  { id: "strategy-session", name: "Strategy Session", arrangements: [F, C, T], panes: ["command", "chat", "procedure", "mindMap", "redTeam", "theories", "decisions", "law", "damages", "witnesses", "caseReconstruction", "audioOverview", "trace"] },
  { id: "motion-drafting", name: "Motion Drafting", arrangements: [F, F, T], panes: ["command", "chat", "procedure", "law", "decisions", "legalIssues", "theories", "trace"] },
  { id: "settlement-prep", name: "Settlement Prep", arrangements: [F, F, T], panes: ["command", "chat", "damages", "witnesses", "theories", "decisions", "procedure"] },
  { id: "cross-exam-prep", name: "Cross-Exam Prep", arrangements: [F, C, T], panes: ["command", "chat", "witnesses", "evidence", "attackStrategy", "defenseStrategy", "redTeam"] },
  { id: "deposition-prep-suite", name: "Deposition Prep Suite", arrangements: [F, C, T], panes: ["command", "chat", "witnesses", "evidence", "redTeam", "attackStrategy", "defenseStrategy", "legalIssues"] },
  { id: "appeal-strategy", name: "Appeal Strategy", arrangements: [F, C, T], panes: ["command", "chat", "procedure", "law", "legalIssues", "strengths", "weaknesses", "theories", "decisions", "trace"] },
  { id: "discovery-command", name: "Discovery Command", arrangements: [F, C, T], panes: ["command", "chat", "evidence", "witnesses", "procedure", "decisions", "caseReconstruction"] },
  { id: "fact-verification", name: "Fact Verification", arrangements: [F, C, T], panes: ["command", "chat", "evidence", "witnesses", "caseReconstruction", "decisions", "trace"] },
  { id: "war-room", name: "War Room", arrangements: [F, C, T, T], panes: ["command", "chat", "evidence", "witnesses", "law", "redTeam", "attackStrategy", "defenseStrategy", "damages", "theories", "decisions", "procedure"] },
  { id: "complex-litigation", name: "Complex Litigation", arrangements: [F, F, C, T], panes: ["command", "chat", "evidence", "procedure", "law", "legalIssues", "strengths", "weaknesses", "theories", "decisions"] },
  { id: "full-team-audit", name: "Full Team Audit", arrangements: [F, C, T, T], panes: ["command", "chat", "witnesses", "evidence", "law", "redTeam", "legalIssues", "weaknesses", "strengths", "damages", "caseReconstruction", "decisions", "theories", "audioOverview", "trace"] },
  // 5 and 6 screens: nothing existed above 4. With only 4 groups a group has to split, so these list their screens by hand (`by`).
  { id: "five-screen-suite", name: "Five-Screen Suite", arrangements: [F, C, C, T, T], by: [["command", "evidence", "procedure", "witnesses", "damages"], ["law", "legalIssues", "decisions"], ["strengths", "weaknesses", "attackStrategy", "defenseStrategy", "redTeam", "theories"], ["chat", "mindMap"], ["caseReconstruction", "audioOverview", "trace"]] },
  { id: "six-screen-suite", name: "Six-Screen Suite", arrangements: [F, C, C, T, T, T], by: [["command", "evidence", "procedure"], ["witnesses", "damages"], ["law", "legalIssues", "decisions"], ["strengths", "weaknesses", "attackStrategy", "defenseStrategy", "redTeam", "theories"], ["chat", "mindMap"], ["caseReconstruction", "audioOverview", "trace"]] },
];

const GROUP_LABELS = ["case file", "law", "strategy", "AI tools"];
const ORDINALS = ["primary", "second", "third", "fourth", "fifth", "sixth"];

const groupOf = (id: PanelId) => Math.floor(panelGroupRank(id) / 100);

/** Splits panes over `k` screens in group order. A whole group moves to the next screen rather than split, unless it is
 * bigger than a screen; every screen gets at least one pane. Order within a screen is group order. */
export function splitByGroup(panes: PanelId[], k: number): PanelId[][] {
  const sorted = [...panes].sort((a, b) => panelGroupRank(a) - panelGroupRank(b));
  const capacity = Math.ceil(sorted.length / k);
  const screens: PanelId[][] = Array.from({ length: k }, () => []);
  let cursor = 0;
  sorted.forEach((id, i) => {
    const used = screens[cursor]!.length;
    const startsGroup = i === 0 || groupOf(id) !== groupOf(sorted[i - 1]!);
    const groupLeft = sorted.filter((p) => groupOf(p) === groupOf(id)).length;
    const mustAdvance = sorted.length - i <= k - 1 - cursor; // one pane left per remaining screen
    if (cursor < k - 1 && used > 0 && (mustAdvance || used >= capacity || (startsGroup && used + groupLeft > capacity))) cursor++;
    screens[cursor]!.push(id);
  });
  return screens;
}

// 1-screen presets (replace the old New Layout dialog's PresetValue picker, PANE_1/2/4/6). One screen has nothing to
// group, so these are listed as-is.
const SINGLE_SCREEN = [
  { id: "quick-review", labelKey: "presetQuickReview", descriptionKey: "presetQuickReviewDesc", name: "Quick Review", screens: [{ arrangement: "free", panelIds: ["command"] }] },
  { id: "evidence-check", labelKey: "presetEvidenceCheck", descriptionKey: "presetEvidenceCheckDesc", name: "Evidence Check", screens: [{ arrangement: "free", panelIds: ["command","evidence"] }] },
  { id: "case-workspace", labelKey: "presetCaseWorkspace", descriptionKey: "presetCaseWorkspaceDesc", name: "Case Workspace", screens: [{ arrangement: "free", panelIds: ["command","evidence","chat","procedure"] }] },
  { id: "full-research", labelKey: "presetFullResearch", descriptionKey: "presetFullResearchDesc", name: "Full Research", screens: [{ arrangement: "free", panelIds: ["command","evidence","law","mindMap","procedure","chat"] }] },
  { id: "client-call", labelKey: "presetClientCall", descriptionKey: "presetClientCallDesc", name: "Client Call", screens: [{ arrangement: "free", panelIds: ["command","chat"] }] },
  { id: "deposition-prep", labelKey: "presetDepositionPrep", descriptionKey: "presetDepositionPrepDesc", name: "Deposition Prep", screens: [{ arrangement: "free", panelIds: ["witnesses","evidence","redTeam"] }] },
  { id: "deadline-tracker", labelKey: "presetDeadlineTracker", descriptionKey: "presetDeadlineTrackerDesc", name: "Deadline Tracker", screens: [{ arrangement: "free", panelIds: ["procedure","decisions"] }] },
  { id: "appeal-review", labelKey: "presetAppealReview", descriptionKey: "presetAppealReviewDesc", name: "Appeal Review", screens: [{ arrangement: "free", panelIds: ["legalIssues","strengths","weaknesses"] }] },
] as const;

// Ids these presets were seeded under before their rename to workflow-style slugs — deleted on every run so re-seeding
// leaves no orphaned duplicates (upsert can't rename an id).
const OLD_IDS = ["pane-1", "pane-2", "pane-4", "pane-6"];

export const GROUPED_PRESETS = SOURCES.map((s) => ({
  id: s.id,
  labelKey: `preset${s.name.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ?? "").toUpperCase()).replace(/^./, (c) => c.toUpperCase())}`,
  name: s.name,
  screens: (s.by ?? splitByGroup(s.panes!, s.arrangements.length)).map((panelIds, i) => ({ arrangement: s.arrangements[i]!, panelIds })),
})).map((p) => ({ ...p, descriptionKey: `${p.labelKey}Desc` }));

/** The locale text for a preset's description, derived from where the panes ended up. */
export function describePreset(preset: (typeof GROUPED_PRESETS)[number]): string {
  const parts = preset.screens.map((screen, i) => {
    const labels = [...new Set(screen.panelIds.map((id) => GROUP_LABELS[groupOf(id)]!))];
    return `${labels.join(" and ")} on the ${ORDINALS[i]} screen`;
  });
  return `Grouped by topic — ${parts.join(", ")}.`;
}

export async function seedScreenPresets() {
  await prisma.screenPreset.deleteMany({ where: { id: { in: OLD_IDS } } });
  for (const preset of [...SINGLE_SCREEN, ...GROUPED_PRESETS]) {
    const data = {
      labelKey: preset.labelKey,
      descriptionKey: preset.descriptionKey,
      name: preset.name,
      screenCount: preset.screens.length,
      screens: preset.screens as unknown as Prisma.InputJsonValue,
    };
    await prisma.screenPreset.upsert({ where: { id: preset.id }, update: data, create: { id: preset.id, ...data } });
  }
  console.log(`Seeded screen presets: ${[...SINGLE_SCREEN, ...GROUPED_PRESETS].map((p) => p.id).join(", ")}`);
}

