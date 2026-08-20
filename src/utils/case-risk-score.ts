export type RiskLevel = "HIGH" | "MEDIUM" | "LOW";

export interface RiskDriver {
  code:
    | "fatal"
    | "major"
    | "missingEvidence"
    | "contradictions"
    | "amountMismatches"
    | "overdueDeadlines"
    | "upcomingDeadlines"
    | "failedDocuments"
    | "invalidCitations"
    | "unverifiedEvidence";
  count: number;
}

export interface RiskMeterScore {
  score: number;
  level: RiskLevel;
  drivers: RiskDriver[];
}

export interface CaseRiskAnalysis {
  overall: RiskMeterScore;
  liability: RiskMeterScore;
}

export interface RiskScoreInput {
  risks?: { severity: string; status?: string | null }[];
  contradictions?: { kind: string }[];
  documents?: { ragStatus?: string | null }[];
  citations?: { status: string }[];
  deadlines?: { computedDueDate: Date | string; confirmations?: { confirmed: boolean }[] }[];
  matrix?: { authenticity?: string | null; admissibility?: string | null; needsVerify?: boolean | null }[];
  now?: Date;
}

const HIGH_AT = 60;
const MEDIUM_AT = 30;

export function scoreCaseRisks(input: RiskScoreInput): CaseRiskAnalysis {
  const now = input.now ?? new Date();
  const activeRisks = (input.risks ?? []).filter((risk) => (risk.status ?? "OPEN") !== "ACCEPTED");
  const fatal = activeRisks.filter((risk) => risk.severity === "FATAL").length;
  const major = activeRisks.filter((risk) => risk.severity === "MAJOR").length;
  const missingEvidence = activeRisks.filter((risk) => risk.severity === "MISSING_EVIDENCE").length;
  const contradictions = input.contradictions ?? [];
  const amountMismatches = contradictions.filter((hit) => hit.kind === "amount_mismatch").length;
  const failedDocuments = (input.documents ?? []).filter((doc) => doc.ragStatus === "FAILED").length;
  const invalidCitations = (input.citations ?? []).filter((row) => row.status === "INVALID" || row.status === "ADVERSE").length;
  const unverifiedEvidence = (input.matrix ?? []).filter(
    (row) => row.needsVerify || row.authenticity === "unverified" || row.admissibility === "unverified",
  ).length;

  const { overdue, upcoming } = deadlineCounts(input.deadlines ?? [], now);

  return {
    overall: meterFromContributions([
      { code: "fatal", count: fatal, points: fatal * 60 },
      { code: "major", count: major, points: major * 14 },
      { code: "overdueDeadlines", count: overdue, points: overdue * 22 },
      { code: "upcomingDeadlines", count: upcoming, points: upcoming * 12 },
      { code: "contradictions", count: contradictions.length, points: Math.min(30, contradictions.length * 10) },
      { code: "failedDocuments", count: failedDocuments, points: Math.min(20, failedDocuments * 10) },
      { code: "invalidCitations", count: invalidCitations, points: invalidCitations * 12 },
    ]),
    liability: meterFromContributions([
      { code: "missingEvidence", count: missingEvidence, points: missingEvidence * 28 },
      { code: "fatal", count: fatal, points: fatal * 40 },
      { code: "amountMismatches", count: amountMismatches, points: Math.min(42, amountMismatches * 14) },
      { code: "unverifiedEvidence", count: unverifiedEvidence, points: Math.min(24, unverifiedEvidence * 8) },
      { code: "major", count: major, points: major * 10 },
      { code: "contradictions", count: contradictions.length, points: Math.min(20, contradictions.length * 6) },
    ]),
  };
}

function deadlineCounts(deadlines: NonNullable<RiskScoreInput["deadlines"]>, now: Date) {
  let overdue = 0;
  let upcoming = 0;
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (const deadline of deadlines) {
    const due = toDate(deadline.computedDueDate);
    if (Number.isNaN(due.getTime())) continue;
    const dueDay = Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate());
    const days = Math.round((dueDay - startOfToday) / 86_400_000);
    if (days < 0) overdue += 1;
    else if (days <= 7) upcoming += 1;
  }
  return { overdue, upcoming };
}

function meterFromContributions(rows: { code: RiskDriver["code"]; count: number; points: number }[]): RiskMeterScore {
  const score = clamp(Math.round(rows.reduce((sum, row) => sum + row.points, 0)));
  const drivers = rows
    .filter((row) => row.count > 0 && row.points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, 2)
    .map((row) => ({ code: row.code, count: row.count }));
  return { score, level: levelFromScore(score), drivers };
}

export function levelFromScore(score: number): RiskLevel {
  if (score >= HIGH_AT) return "HIGH";
  if (score >= MEDIUM_AT) return "MEDIUM";
  return "LOW";
}

function clamp(score: number) {
  return Math.max(0, Math.min(100, score));
}

function toDate(value: Date | string) {
  return value instanceof Date ? value : new Date(value);
}
