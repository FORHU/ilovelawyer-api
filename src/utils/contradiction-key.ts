/** Fingerprint of one contradiction that survives a rescan: same fact, same two documents, same
 * two values — regardless of which side the scan put each on this time, or case/spacing in the
 * values. Used to carry a lawyer's status (and Jev's classification) onto the re-found row, since
 * every scan rebuilds EvidenceContradiction from scratch. A value the model words differently on
 * the next scan yields a new key, and that row starts OPEN again. */
export function contradictionKey(row: {
  kind: string;
  factKey: string;
  leftDocumentId: string;
  rightDocumentId: string;
  leftValue: string;
  rightValue: string;
  leftLocator?: string | null;
  rightLocator?: string | null;
}): string {
  const norm = (v: string) => v.toLowerCase().replace(/\s+/g, " ").trim();
  // Locators (full-bundle scan only) are part of the key: the same two values can conflict in
  // several places inside one merged PDF, and each is its own contradiction.
  const at = (loc?: string | null) => (loc ? `@${loc}` : "");
  const sides = [
    `${row.leftDocumentId}${at(row.leftLocator)}=${norm(row.leftValue)}`,
    `${row.rightDocumentId}${at(row.rightLocator)}=${norm(row.rightValue)}`,
  ].sort();
  return [row.kind, row.factKey, ...sides].join("|");
}
