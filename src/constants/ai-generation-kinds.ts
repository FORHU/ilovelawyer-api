/** `AiGenerationJob.kind` values — a const tuple rather than a Prisma enum so a new kind never
 * needs a migration, just a call site. Kept in one place so call sites can't typo a string. */
export const AI_GENERATION_KINDS = [
  "redTeam",
  "caseReconstruction",
  "caseRefresh",
  "contradictions",
  "caseStrategy",
  "caseFinding",
  "mindMap",
  "audioOverviewScript",
  "citationExpand",
] as const;

export type AiGenerationKind = (typeof AI_GENERATION_KINDS)[number];
