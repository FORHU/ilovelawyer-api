export interface WeeklyTrendPoint {
  /** Monday 00:00 UTC that starts the bucket. */
  weekStart: string;
  /** Items created during this week. */
  added: number;
  /** Items created up to the end of this week. */
  total: number;
}

export interface CaseTrends {
  openIssues: WeeklyTrendPoint[];
  evidence: WeeklyTrendPoint[];
}

export interface CaseTrendInput {
  risks: { createdAt: Date; status: string }[];
  documents: { createdAt: Date }[];
  weeks: number;
  now?: Date;
}

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** KPI-tile sparklines derived from existing timestamps — no stored history. "Open issues" counts
 * risks that are OPEN today, bucketed by when they were created: a risk closed last week is not
 * counted in any earlier bucket, because when it closed isn't recorded. Good enough for a
 * sparkline, not for an audit. */
export function buildCaseTrends(input: CaseTrendInput): CaseTrends {
  const now = input.now ?? new Date();
  const openRiskDates = input.risks.filter((risk) => risk.status === "OPEN").map((risk) => risk.createdAt);
  return {
    openIssues: weeklyTrend(openRiskDates, input.weeks, now),
    evidence: weeklyTrend(input.documents.map((doc) => doc.createdAt), input.weeks, now),
  };
}

export function weeklyTrend(dates: Date[], weeks: number, now: Date): WeeklyTrendPoint[] {
  const firstWeekStart = startOfUtcWeek(now) - (weeks - 1) * WEEK_MS;
  const times = dates.map((date) => date.getTime()).filter((time) => !Number.isNaN(time));

  let total = times.filter((time) => time < firstWeekStart).length;
  const points: WeeklyTrendPoint[] = [];
  for (let i = 0; i < weeks; i++) {
    const start = firstWeekStart + i * WEEK_MS;
    const end = start + WEEK_MS;
    const added = times.filter((time) => time >= start && time < end).length;
    total += added;
    points.push({ weekStart: new Date(start).toISOString(), added, total });
  }
  return points;
}

function startOfUtcWeek(date: Date): number {
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const daysSinceMonday = (new Date(midnight).getUTCDay() + 6) % 7;
  return midnight - daysSinceMonday * DAY_MS;
}
