/**
 * Citation ranking — the pure part. Which cited authorities should a lawyer advising THIS user
 * read first? Anchored to the user's message, never to the answer's own reasoning (an answer that
 * leans on a weak authority for a wrong conclusion must not lift that authority).
 *
 * Two layers: objective signals computed here (named by the user, court level, instrument type),
 * and a Jev judgement (citation-rank-jev.ts). `combineTier` merges them. See chat-wonder-v2-api
 * docs/handoffs/handoff-citation-ranking-2026-09-30.md for the decisions and the Phase 0 findings.
 */

export type RankTier = "HIGH" | "MEDIUM" | "LOW" | "UNRATED";
export type Level = "HIGH" | "MEDIUM" | "LOW";
export type AuthorityKind = "legislation" | "case";

export interface RankableAuthority {
  /** The key the app looks the tier up by: the final Library href of the rewritten link. */
  id: string;
  label: string;
  kind: AuthorityKind;
  /** The pre-rewrite source URL (legislation.gov.uk, caselaw.nationalarchives.gov.uk, juris.ph), if known. */
  sourceUrl?: string | null;
  /** PH court division as returned by juris.ph ("En Banc", "First Division", ...), if known. */
  division?: string | null;
  year?: number | null;
  /** The authority's own text or summary from the Library, handed to Jev. */
  text?: string | null;
}

export interface AuthoritySignals {
  namedByUser: boolean;
  /** 1 = highest court. null when unknown or not a case. */
  courtLevel: number | null;
  courtName: string | null;
  /** UK instrument type (ukpga, uksi, eur, ...) for legislation. */
  instrument: string | null;
}

/** Below this top probability a Jev verdict is treated as a guess. Provisional: the repo's other
 * pilots use `confidence` against 0.5, but Phase 0 showed `confidence` is not the chosen option's
 * probability (a 0.58 probability reported 0.36), so this reads `probabilities` directly. */
export const MIN_TOP_PROBABILITY = 0.5;

const UK_COURTS: Array<[RegExp, number, string]> = [
  [/^\/(uksc|ukpc)\//, 1, "Supreme Court / Privy Council"],
  [/^\/ewca\//, 2, "Court of Appeal"],
  [/^\/(ewhc|ewcop|ewfc)\//, 3, "High Court"],
  [/^\/(eat|ukut)\//, 4, "EAT / Upper Tribunal"],
  [/^\/(ukftt|ukeat|ukit|ewcr)\//, 5, "Tribunal"],
];

/** En Banc outranks a Division. Matching is case-insensitive: juris.ph returns both "First Division"
 * and "FIRST DIVISION" (measured in Phase 0). */
export function phCourtLevel(division?: string | null): { level: number; name: string } | null {
  const d = (division ?? "").trim().toLowerCase();
  if (!d) return null;
  if (d.includes("en banc")) return { level: 1, name: "Supreme Court (En Banc)" };
  if (d.includes("division")) return { level: 2, name: `Supreme Court (${division!.trim().replace(/\s+/g, " ")})` };
  return null;
}

export function ukCourtLevel(sourceUrl?: string | null): { level: number; name: string } | null {
  if (!sourceUrl) return null;
  let pathname: string;
  try {
    pathname = new URL(sourceUrl).pathname.toLowerCase();
  } catch {
    return null;
  }
  const hit = UK_COURTS.find(([re]) => re.test(pathname));
  return hit ? { level: hit[1], name: hit[2] } : null;
}

export function ukInstrument(sourceUrl?: string | null): string | null {
  if (!sourceUrl) return null;
  try {
    const m = new URL(sourceUrl).pathname.toLowerCase().match(/^\/(ukpga|uksi|asp|anaw|eur|eudr|eudn|ukla|wsi|nisr)\//);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

const STOP = new Set(["the", "and", "ltd", "limited", "plc", "llp", "inc", "corp", "company", "co", "of", "for", "act", "section", "regulation", "regulations", "order", "uk", "ph"]);

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Words too common to identify a case on their own ("Royal Mail", "Secretary of State", "London Borough"). */
const GENERIC_PARTY_WORDS = new Set(["royal", "national", "general", "secretary", "state", "london", "borough", "council", "county", "city", "home", "office", "crown", "minister", "ministry", "people", "republic", "philippines", "regina", "commissioner", "revenue", "customs", "chief", "constable", "attorney"]);

/** One identifying token per side of a case label, ignoring parentheticals and the neutral citation.
 * Lawyers cite a case by either party, so "Bilta" alone names "Jetivia SA v Bilta (UK) Ltd (in
 * liquidation) [2015] UKSC 23", and "R v Misra [2004] EWCA Crim 2375" yields ["misra"]. */
function casePartyTokens(label: string): string[] {
  const name = label
    .replace(/[\[(]\s*\d{4}\s*[\])].*$/, "")
    .replace(/\bG\.?R\.?\s*(?:No|Nos)\b.*$/i, "")
    .replace(/\([^)]*\)/g, " ");
  return name
    .split(/\s+(?:v|vs|versus)\.?\s+/i)
    .map((side) => norm(side).split(" ").find((t) => t.length >= 4 && !STOP.has(t) && !GENERIC_PARTY_WORDS.has(t)))
    .filter((t): t is string => !!t);
}

/** "Health and Safety at Work etc. Act" gives "hswa"; "Criminal Justice Act" gives "cja". */
function acronymOf(titleWithoutYear: string): string {
  const skip = new Set(["and", "at", "of", "the", "etc", "for", "in", "to", "on"]);
  return titleWithoutYear
    .split(" ")
    .filter((w) => w && !skip.has(w))
    .map((w) => w[0])
    .join("");
}

/** The statute title with the provision stripped: "Health and Safety at Work etc. Act 1974, s 37"
 * gives "health and safety at work etc act 1974" and the provision number "37". */
function statuteParts(label: string): { title: string; provision: string | null } {
  const m = label.match(/^(.*?)(?:,?\s+(?:ss?|sections?|reg(?:ulation)?s?|art(?:icle)?s?|sch(?:edule)?)\.?\s*(\d+[A-Za-z]*)(?:\s*[-–,&]\s*\d+[A-Za-z]*)*)?\s*$/i);
  const title = norm(m?.[1] ?? label).replace(/\bact\b/g, "act");
  return { title, provision: m?.[2] ? m[2].toLowerCase() : null };
}

/**
 * True when the user's own message names this authority. A case counts when either party's
 * identifying token appears ("Bilta" names Jetivia v Bilta; generic words like "Royal" never count
 * on their own); a statute counts when its title appears and, if the label carries a provision,
 * that provision number also appears next to an "s"/"section" marker.
 */
export function isNamedByUser(a: Pick<RankableAuthority, "label" | "kind">, userMessage: string): boolean {
  const msg = norm(userMessage);
  if (!msg) return false;
  if (a.kind === "case") {
    return casePartyTokens(a.label).some((t) => new RegExp(`\\b${t}\\b`).test(msg));
  }
  const { title, provision } = statuteParts(a.label);
  if (!title) return false;
  const dropEtc = (s: string) => s.replace(/\s+etc\b/, "");
  const noYear = title.replace(/\s+\d{4}$/, "");
  const acronym = acronymOf(noYear);
  // every way the user might have referred to this Act, as regex sources over the normalised message
  const refs: string[] = [escapeRe(dropEtc(title))];
  if (noYear.split(" ").length >= 3) refs.push(escapeRe(dropEtc(noYear)));
  if (acronym.length >= 3) refs.push(`${acronym}(?:\\s+\\d{4})?`);
  const ref = `(?:${refs.join("|")})`;
  if (!new RegExp(`\\b${ref}\\b`).test(msg)) return false;
  if (!provision) return true;
  // The provision must sit next to THIS Act: "s 37 HSWA", "ss 119 and 120 CJA 2003", "s 1 of the
  // Corporate Manslaughter ... Act", or "HSWA 1974 s 37". A bare "s 3" that belongs to another Act
  // (the user wrote "s.3 of the Criminal Procedure Act 1865") must not count.
  const one = "(?:s|sec|section|reg|regulation|art|article|sch|schedule)";
  const many = "(?:ss|secs|sections|regs|arts|articles)";
  const prov = escapeRe(provision);
  const nums = "((?:\\d+[a-z]*\\s*(?:,|and|&|to)?\\s*)+)";
  const has = (listText: string | undefined) => !!listText && new RegExp(`\\b${prov}\\b`).test(listText);
  const singleBefore = new RegExp(`\\b${one}\\s*${prov}\\b\\s*(?:of\\s+(?:the\\s+)?)?${ref}\\b`);
  const singleAfter = new RegExp(`\\b${ref}\\s*(?:\\d{4}\\s*)?${one}\\s*${prov}\\b`);
  const listBefore = msg.match(new RegExp(`\\b${many}\\s*${nums}(?:of\\s+(?:the\\s+)?)?${ref}\\b`));
  const listAfter = msg.match(new RegExp(`\\b${ref}\\s*(?:\\d{4}\\s*)?${many}\\s*${nums}`));
  return singleBefore.test(msg) || singleAfter.test(msg) || has(listBefore?.[1]) || has(listAfter?.[1]);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function deterministicSignals(a: RankableAuthority, userMessage: string): AuthoritySignals {
  const court = a.kind === "case" ? phCourtLevel(a.division) ?? ukCourtLevel(a.sourceUrl) : null;
  return {
    namedByUser: isNamedByUser(a, userMessage),
    courtLevel: court?.level ?? null,
    courtName: court?.name ?? null,
    instrument: a.kind === "legislation" ? ukInstrument(a.sourceUrl) : null,
  };
}

export interface JevVerdict {
  choice: Level;
  /** Probability Jev assigned to the chosen option, 0..1. */
  topProbability: number;
}

export interface JevRating {
  relevance: JevVerdict | null;
  importance: JevVerdict | null;
}

export interface RankResult {
  id: string;
  tier: RankTier;
  relevance: Level | null;
  importance: Level | null;
  signals: AuthoritySignals;
  /** One line for the tooltip. Says WHY, never that the authority is correct or the advice sound. */
  reason: string;
}

function usable(v: JevVerdict | null): Level | null {
  return v && v.topProbability >= MIN_TOP_PROBABILITY ? v.choice : null;
}

/**
 * Merge the objective signals with Jev. Rules, in order:
 *  1. The user named it: relevance is HIGH whatever Jev said (a lawyer must read what the client asked about).
 *  2. A verdict under MIN_TOP_PROBABILITY counts as missing, never as a guess.
 *  3. No usable relevance: UNRATED, shown neutral (decision D8). Importance alone never colours a link.
 *  4. HIGH only when relevance is HIGH and importance is not LOW; LOW when relevance is LOW; else MEDIUM.
 * The mapping is provisional and is what Phase 4 calibration tunes.
 */
export function combineTier(signals: AuthoritySignals, jev: JevRating | null): Omit<RankResult, "id" | "signals"> {
  const relevance: Level | null = signals.namedByUser ? "HIGH" : usable(jev?.relevance ?? null);
  const importance = usable(jev?.importance ?? null);
  if (!relevance) return { tier: "UNRATED", relevance: null, importance, reason: "Not enough signal to rate this authority." };

  let tier: RankTier;
  if (relevance === "LOW") tier = "LOW";
  else if (relevance === "HIGH" && importance !== "LOW") tier = "HIGH";
  else tier = "MEDIUM";

  // Facts only. The app explains what the relevance and importance levels mean in plain words, so
  // this carries just what the levels cannot: that the user named it, and which court decided it.
  const bits: string[] = [];
  if (signals.namedByUser) bits.push("You named it in your question");
  if (signals.courtName) bits.push(signals.courtName);
  return { tier, relevance, importance, reason: bits.length ? bits.join(" · ") : "" };
}

export function rankAuthority(a: RankableAuthority, userMessage: string, jev: JevRating | null): RankResult {
  const signals = deterministicSignals(a, userMessage);
  return { id: a.id, signals, ...combineTier(signals, jev) };
}

const TIER_ORDER: Record<RankTier, number> = { HIGH: 0, MEDIUM: 1, LOW: 2, UNRATED: 3 };

/** Sort comparator for the Sources panel: tier first, then higher court, then input order. */
export function compareByTier(a: RankResult, b: RankResult): number {
  const t = TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
  if (t !== 0) return t;
  return (a.signals.courtLevel ?? 99) - (b.signals.courtLevel ?? 99);
}
