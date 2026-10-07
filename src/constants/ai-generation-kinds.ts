/** `AiGenerationJob.kind` values — a const tuple rather than a Prisma enum so a new kind never
 * needs a migration, just a call site. Kept in one place so call sites can't typo a string. */
export const AI_GENERATION_KINDS = [
  "redTeam",
  "caseReconstruction",
  "caseRefresh",
  "contradictions",
  "caseStrategy",
  "caseStrategyRefresh",
  "caseFinding",
  // One findings panel's own "Regenerate" (CaseFindingAiSvc.regenerateCategory) — separate kinds
  // so only that panel shows it running.
  "weaknessRegenerate",
  "strengthRegenerate",
  "legalIssueRegenerate",
  "attackRegenerate",
  "defenseRegenerate",
  // A pane's own Regenerate that runs two steps in a row (read new documents, then score or
  // re-rate) — its own kind, so only that pane shows it running.
  "witnessRefresh",
  "damagesRefresh",
  "caseOutlook",
  "mindMap",
  "mindMapExpand",
  "caseMindMap",
  "audioOverviewScript",
  "citationExpand",
  "caseTheoryPropose",
  "theoryDiff",
  "caseReconstructionScenes",
  "caseReconstructionEvents",
  "caseReconstructionTableRead",
  "timelineGenerate",
  "witnessScoring",
  "witnessExtract",
  "damagesExtract",
  "claimExtract",
  "citationGrounds",
  "adverseSweep",
  "missingEvidence",
] as const;

export type AiGenerationKind = (typeof AI_GENERATION_KINDS)[number];

/** The kinds a Terminal pane's own Regenerate runs under (ADR 0018). A pane run and the case
 * analysis never overlap: while any of these is running, "Refresh analysis" waits
 * (AiGenerationLockSvc.assertNoPaneRunning), and while the analysis runs, every pane's route refuses
 * (assertAnalysisIdle). Some are also held by the analysis's own steps, which is why the check runs
 * before the analysis claims its lock, never during. */
export const PANE_REGENERATE_KINDS = [
  "caseOutlook",
  "caseStrategyRefresh",
  "timelineGenerate",
  "contradictions",
  "legalIssueRegenerate",
  "strengthRegenerate",
  "weaknessRegenerate",
  "attackRegenerate",
  "defenseRegenerate",
  "witnessRefresh",
  "damagesRefresh",
  "caseReconstruction",
  "caseTheoryPropose",
  "caseMindMap",
  "redTeam",
  "audioOverviewScript",
  "missingEvidence",
] as const satisfies readonly AiGenerationKind[];
