/** What produced a trace run. "chat" is a question asked in the chat; the rest are the AI
 * generations a pane runs (and the two chat-driven ones, mind map and audio overview). The pane
 * names each run by its source and numbers it within that source — "Witness scoring 2" — and
 * filters by it. Sent to the app as-is, so a new source needs a label there too. */
export const TRACE_SOURCES = [
  "chat",
  "witnessExtract",
  "witnessScoring",
  "caseReconstruction",
  "caseScenes",
  "caseEvents",
  "redTeam",
  "caseStrategy",
  "caseTheory",
  "theoryDiff",
  "caseMindMap",
  "mindMap",
  "audioOverview",
  "damagesExtract",
  "citationGround",
  "claimExtract",
  "caseFindings",
  "caseOutlook",
  "contradictionScan",
] as const;

export type TraceSource = (typeof TRACE_SOURCES)[number];
