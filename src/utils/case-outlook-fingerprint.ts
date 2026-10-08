import crypto from "crypto";

/** Bump when the outlook prompt changes enough that an unchanged case should still get a new run. */
export const OUTLOOK_PROMPT_VERSION = 1;

export interface CaseOutlookFingerprintInput {
  docs: { id: string; name: string }[];
  findings: { category: string; tag?: string | null }[];
  openRisks: { title: string; severity: string }[];
  deadlines: { label: string; computedDueDate: Date }[];
  language: string;
  tenantCode: string;
  ukJurisdiction?: string | null;
}

/**
 * CaseOutlook.inputFingerprint: what the outlook was built from. The model's answer varies run to
 * run, so re-asking with the same material only makes the gauge drift; a run whose fingerprint
 * matches the current outlook's keeps it instead (CaseOutlookAiSvc).
 *
 * Findings count by category and tag only. The case analysis rewrites their wording on every run,
 * so hashing the text would make every refresh look like a change; a lawyer resolving, closing or
 * adding one still changes the fingerprint. Contradictions are left out for the same reason (an
 * AI scan with no lawyer-set state on the prompt's fields).
 */
export function computeCaseOutlookFingerprint(input: CaseOutlookFingerprintInput): string {
  const sorted = (lines: string[]) => [...lines].sort();
  const material = {
    v: OUTLOOK_PROMPT_VERSION,
    tenant: input.tenantCode,
    jurisdiction: input.ukJurisdiction ?? null,
    language: input.language,
    docs: sorted(input.docs.map((d) => `${d.id}\u0000${d.name}`)),
    findings: sorted(input.findings.map((f) => `${f.category}\u0000${f.tag ?? ""}`)),
    risks: sorted(input.openRisks.map((r) => `${r.severity}\u0000${r.title}`)),
    deadlines: sorted(input.deadlines.map((d) => `${d.label}\u0000${d.computedDueDate.toISOString().slice(0, 10)}`)),
  };
  return crypto.createHash("sha256").update(JSON.stringify(material)).digest("hex");
}
