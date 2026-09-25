export type AuthorityStanceValue = "STATUTE" | "ON_POINT" | "ADVERSE";

export interface AuthoritySummary {
  statute: number;
  onPoint: number;
  adverse: number;
  total: number;
  /** Share of cited authority that is on point (0–1); null when nothing is cited. */
  coverage: number | null;
}

export function summarizeAuthorities(rows: { stance: AuthorityStanceValue }[]): AuthoritySummary {
  const count = (stance: AuthorityStanceValue) => rows.filter((row) => row.stance === stance).length;
  const onPoint = count("ON_POINT");
  return {
    statute: count("STATUTE"),
    onPoint,
    adverse: count("ADVERSE"),
    total: rows.length,
    coverage: rows.length ? onPoint / rows.length : null,
  };
}
