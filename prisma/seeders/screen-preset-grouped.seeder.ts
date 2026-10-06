import prisma from "../../src/lib/prisma";
import { Prisma } from "@prisma/client";
import { type ArrangementValue, type PanelId } from "../../src/constants";

// Every system screen preset, one workflow each, authored by hand: which panes go on which screen and which arrangement
// that screen uses. Free = a canvas for spatial panes (mind map, timeline); Columns = panes side by side for study and
// drafting; Focus = one big pane plus the pinned Chat, for one-thing-at-a-time work (the Chat is drawn by Focus itself, so
// it is not listed here). The picker filters by connected screen count, and 7+ screens only get the generated "Spread Evenly".
// Idempotent (upserts on id). userId is left absent: system presets, global to every user.
const [F, C, O]: ArrangementValue[] = ["free", "columns", "focus"];

type Screen = [ArrangementValue, PanelId[]];
const SOURCES: { id: string; name: string; screens: Screen[] }[] = [
  // 1 screen
  { id: "client-call", name: "Client Call", screens: [[O, ["command", "evidence"]]] },
  { id: "evidence-check", name: "Evidence Check", screens: [[C, ["command", "evidence", "witnesses"]]] },
  { id: "evidence-check-free", name: "Evidence Check (Free)", screens: [[F, ["evidence", "witnesses", "mindMap"]]] },
  { id: "case-workspace", name: "Case Workspace", screens: [[F, ["command", "evidence", "procedure", "mindMap", "chat"]]] },
  { id: "case-workspace-columns", name: "Case Workspace (Columns)", screens: [[C, ["command", "evidence", "procedure", "chat"]]] },
  { id: "deadline-tracker", name: "Deadline Tracker", screens: [[C, ["procedure", "decisions"]]] },
  { id: "appeal-review", name: "Appeal Review", screens: [[C, ["legalIssues", "strengths", "weaknesses"]]] },
  { id: "witness-prep", name: "Witness Prep", screens: [[O, ["witnesses", "evidence", "redTeam"]]] },
  { id: "client-reporting", name: "Client Reporting", screens: [[O, ["command", "decisions", "mindMap"]]] },
  // 2 screens
  { id: "trial-prep", name: "Trial Prep", screens: [[C, ["command", "evidence", "witnesses", "procedure"]], [O, ["law", "redTeam", "theories"]]] },
  { id: "trial-prep-focus", name: "Trial Prep (Focus)", screens: [[O, ["command", "evidence", "witnesses"]], [O, ["law", "redTeam", "theories"]]] },
  { id: "trial-prep-free", name: "Trial Prep (Free)", screens: [[F, ["command", "evidence", "witnesses", "procedure"]], [F, ["law", "redTeam", "theories", "mindMap"]]] },
  { id: "deposition-prep", name: "Deposition Prep", screens: [[C, ["command", "evidence", "witnesses"]], [O, ["attackStrategy", "redTeam"]]] },
  { id: "research-deep-dive", name: "Research Deep-Dive", screens: [[F, ["law", "legalIssues", "decisions", "mindMap"]], [O, ["command", "evidence", "theories"]]] },
  { id: "research-deep-dive-columns", name: "Research Deep-Dive (Columns)", screens: [[C, ["law", "legalIssues", "decisions"]], [C, ["command", "evidence", "theories", "mindMap"]]] },
  { id: "settlement-prep", name: "Settlement Prep", screens: [[C, ["command", "evidence", "damages"]], [F, ["theories", "decisions", "mindMap"]]] },
  { id: "client-intake", name: "Client Intake", screens: [[C, ["command", "evidence"]], [F, ["procedure", "mindMap", "chat"]]] },
  { id: "discovery-review", name: "Discovery Review", screens: [[C, ["evidence", "procedure", "decisions"]], [O, ["command", "witnesses"]]] },
  { id: "document-review", name: "Document Review", screens: [[O, ["evidence", "command"]], [C, ["witnesses", "damages", "procedure"]]] },
  { id: "mediation-session", name: "Mediation Session", screens: [[O, ["command", "damages"]], [C, ["theories", "decisions", "evidence"]]] },
  // 3 screens
  { id: "trial-day", name: "Trial Day", screens: [[C, ["command", "evidence", "witnesses"]], [O, ["law", "legalIssues"]], [C, ["strengths", "weaknesses", "attackStrategy", "defenseStrategy", "redTeam"]]] },
  { id: "appeal-prep", name: "Appeal Prep", screens: [[C, ["command", "procedure"]], [O, ["law", "legalIssues", "decisions"]], [C, ["strengths", "weaknesses", "theories"]]] },
  { id: "strategy-session", name: "Strategy Session", screens: [[F, ["mindMap", "theories", "decisions"]], [C, ["strengths", "weaknesses", "attackStrategy", "defenseStrategy"]], [O, ["command", "law", "redTeam"]]] },
  { id: "motion-drafting", name: "Motion Drafting", screens: [[O, ["law", "decisions"]], [C, ["command", "procedure", "legalIssues"]], [F, ["theories", "mindMap"]]] },
  { id: "deposition-day", name: "Deposition Day", screens: [[C, ["witnesses", "evidence"]], [O, ["attackStrategy", "redTeam"]], [C, ["command", "procedure"]]] },
  { id: "settlement-suite", name: "Settlement Suite", screens: [[C, ["command", "evidence", "damages"]], [O, ["witnesses", "theories"]], [F, ["decisions", "mindMap"]]] },
  { id: "discovery-command", name: "Discovery Command", screens: [[C, ["evidence", "procedure"]], [O, ["witnesses", "decisions"]], [F, ["caseReconstruction", "trace", "mindMap"]]] },
  // 4 screens
  { id: "war-room", name: "War Room", screens: [[C, ["command", "evidence", "procedure", "witnesses", "damages"]], [O, ["law", "legalIssues", "decisions"]], [C, ["strengths", "weaknesses", "attackStrategy", "defenseStrategy", "redTeam", "theories"]], [F, ["mindMap", "caseReconstruction", "audioOverview", "trace"]]] },
  { id: "complex-litigation", name: "Complex Litigation", screens: [[C, ["command", "evidence", "procedure"]], [O, ["law", "legalIssues"]], [C, ["strengths", "weaknesses", "attackStrategy", "defenseStrategy"]], [F, ["mindMap", "theories", "decisions"]]] },
  { id: "full-team-audit", name: "Full Team Audit", screens: [[C, ["command", "evidence", "witnesses", "damages"]], [O, ["law", "decisions"]], [C, ["strengths", "weaknesses", "redTeam"]], [F, ["caseReconstruction", "audioOverview", "trace"]]] },
  { id: "cross-exam-lab", name: "Cross-Exam Lab", screens: [[C, ["witnesses", "evidence"]], [O, ["attackStrategy", "defenseStrategy"]], [C, ["redTeam", "weaknesses", "strengths"]], [F, ["mindMap", "trace"]]] },
  // 5 and 6 screens (beyond these, the generated "Spread Evenly" applies)
  { id: "five-screen-suite", name: "Five-Screen Suite", screens: [[C, ["command", "evidence", "procedure", "witnesses", "damages"]], [O, ["law", "legalIssues", "decisions"]], [C, ["strengths", "weaknesses", "attackStrategy", "defenseStrategy", "redTeam", "theories"]], [F, ["mindMap"]], [F, ["caseReconstruction", "audioOverview", "trace"]]] },
  { id: "six-screen-suite", name: "Six-Screen Suite", screens: [[C, ["command", "evidence", "procedure"]], [C, ["witnesses", "damages"]], [O, ["law", "legalIssues", "decisions"]], [C, ["strengths", "weaknesses", "attackStrategy", "defenseStrategy", "redTeam", "theories"]], [F, ["mindMap"]], [F, ["caseReconstruction", "audioOverview", "trace"]]] },
];

// Every other system preset is dropped on every run, so a re-seed leaves no stale ones behind (upsert can't remove, and an id
// can't be renamed in place).
const KEEP_IDS = SOURCES.map((s) => s.id);

export const PRESETS = SOURCES.map((s) => {
  // Locale keys follow the name: "Research Deep-Dive" -> presetResearchDeepDive / presetResearchDeepDiveDesc.
  const labelKey = `preset${s.name.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ?? "").toUpperCase()).replace(/^./, (c) => c.toUpperCase())}`;
  return { id: s.id, name: s.name, labelKey, descriptionKey: `${labelKey}Desc`, screens: s.screens.map(([arrangement, panelIds]) => ({ arrangement, panelIds })) };
});

export async function seedScreenPresets() {
  await prisma.screenPreset.deleteMany({ where: { userId: null, id: { notIn: KEEP_IDS } } });
  for (const preset of PRESETS) {
    const data = {
      labelKey: preset.labelKey,
      descriptionKey: preset.descriptionKey,
      name: preset.name,
      screenCount: preset.screens.length,
      screens: preset.screens as unknown as Prisma.InputJsonValue,
    };
    await prisma.screenPreset.upsert({ where: { id: preset.id }, update: data, create: { id: preset.id, ...data } });
  }
  console.log(`Seeded screen presets: ${KEEP_IDS.join(", ")}`);
}
