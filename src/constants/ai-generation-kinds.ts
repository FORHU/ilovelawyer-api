/** `AiGenerationJob.kind` values — a const tuple rather than a Prisma enum so a new kind never
 * needs a migration, just a call site. Kept in one place so call sites can't typo a string. */
export const AI_GENERATION_KINDS = [
  "redTeam",
  "caseReconstruction",
  "caseRefresh",
  "contradictions",
  "caseStrategy",
  "caseFinding",
  "caseOutlook",
  "mindMap",
  "mindMapExpand",
  "audioOverviewScript",
  "citationExpand",
  "caseTheoryPropose",
  "theoryDiff",
  "caseReconstructionScenes",
  "caseReconstructionTableRead",
  "timelineGenerate",
] as const;

export type AiGenerationKind = (typeof AI_GENERATION_KINDS)[number];
