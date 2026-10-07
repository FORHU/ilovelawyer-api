export type AuthorityStanceValue = "STATUTE" | "ON_POINT" | "ADVERSE";

export interface AuthoritySummary {
  statute: number;
  onPoint: number;
  adverse: number;
  total: number;
  /** Pleaded grounds (Legal Issue findings). Authorities not tied to a ground don't count toward these. */
  groundsTotal: number;
  /** Grounds with at least one statute or on-point authority. */
  groundsSupported: number;
  /** Grounds with at least one adverse authority — may also be supported. */
  groundsContested: number;
  /** Authorities not tied to any current ground; they support nothing in the coverage figure. */
  unlinked: number;
  /** groundsSupported ÷ groundsTotal (0–1); null when the case has no grounds. */
  coverage: number | null;
}

export function summarizeAuthorities(
  rows: { stance: AuthorityStanceValue; findingId: string | null }[],
  grounds: { id: string }[],
): AuthoritySummary {
  const count = (stance: AuthorityStanceValue) => rows.filter((row) => row.stance === stance).length;
  const stancesOf = (groundId: string) => rows.filter((row) => row.findingId === groundId).map((row) => row.stance);
  const perGround = grounds.map((ground) => stancesOf(ground.id));
  const groundsSupported = perGround.filter((s) => s.some((x) => x !== "ADVERSE")).length;
  return {
    statute: count("STATUTE"),
    onPoint: count("ON_POINT"),
    adverse: count("ADVERSE"),
    total: rows.length,
    groundsTotal: grounds.length,
    groundsSupported,
    unlinked: rows.filter((row) => !grounds.some((g) => g.id === row.findingId)).length,
    groundsContested: perGround.filter((s) => s.includes("ADVERSE")).length,
    coverage: grounds.length ? groundsSupported / grounds.length : null,
  };
}
