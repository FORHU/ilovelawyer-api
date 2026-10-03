/**
 * Whether a case is a criminal prosecution, from what the case record says about itself. The
 * action type is optional and often left unset (R v Doyle carried none), so the case name's
 * prosecution form ("R v Doyle", "Regina v …", "People of the Philippines v …") and a criminal
 * venue ("Reading Crown Court", "… Magistrates' Court") count too.
 */
const CRIMINAL_ACTION_TYPES = new Set(["criminal proceeding"]);
const PROSECUTION_NAME_RE = /^\s*(?:r|rex|regina|the\s+(?:king|queen|crown)|hma|hm\s+advocate|people(?:\s+of\s+the\s+philippines)?)\s+v\.?s?\.?\s/i;
// Courts that only hear criminal cases. (A Sheriff Court hears civil cases too, so it doesn't count.)
const CRIMINAL_VENUE_RE = /\b(?:crown\s+court|magistrates'?\s+court|youth\s+court|high\s+court\s+of\s+justiciary)\b/i;

export function isCriminalCase(c: { caseName?: string | null; actionType?: string | null; jurisdiction?: string | null }): boolean {
  if (c.actionType && CRIMINAL_ACTION_TYPES.has(c.actionType.trim().toLowerCase())) return true;
  if (c.caseName && PROSECUTION_NAME_RE.test(c.caseName)) return true;
  return Boolean(c.jurisdiction && CRIMINAL_VENUE_RE.test(c.jurisdiction));
}
