import LawRepo from "../repositories/law.repository";
import { legislationUrlParts } from "../legal/law-source/uk/uk-law-mappers";
import { extractCaseUri } from "./uk-citation-resolution";
import { grepJudgment, judgmentGetParagraph, legislationGetSection } from "./uk-legal-mcp";
import { formatPinpointFromEid } from "./citation-pinpoint";
import { matchQuote, NEGATIONS, tokens } from "./citation-validity";
import { TenantCode } from "../types/tenant-code";
import logger from "./logger";

/**
 * #364: a citation is only verified against official text, and until now that text only came
 * from the lawyer pasting it in. When they haven't, this fetches it from the authority the
 * citation resolved to (CitationCheckSvc.resolveAuthority) — narrowed to the passage the quote is
 * about, so the check (and Jev) compares like with like and the lawyer can see which part was used.
 *
 * - PH decisions and statutes: the document's full text (LawSvc.fullTextFor — fetched once from
 *   its PDF and cached on Law.fullText), narrowed with locatePassage.
 * - UK legislation: the cited section, from the UK Legal MCP.
 * - UK judgments: the paragraph the quote is in — found by searching the judgment for the quote,
 *   or for its most distinctive words when it isn't verbatim — fetched in full.
 *
 * Best-effort throughout: any failure, or the time limit, means no text, and the check falls back
 * to "not checked" exactly as before.
 */

export type OfficialTextSourceKind = "PH_LAW" | "UK_LEGISLATION" | "UK_JUDGMENT";

export interface FetchedOfficialText {
  text: string;
  source: OfficialTextSourceKind;
  /** Where in the authority: "s. 13", "para_37"; null when the source has no finer address (a PDF). */
  ref: string | null;
  /** For a UK judgment, the paragraph as a pinpoint ("para. 37"), so it needn't be searched twice. */
  pinpoint?: string | null;
  /** The authority as the lawyer would name it, for the citation's notes. */
  label: string;
}

type LawSummary = { id: string; title: string; category: string; jurisSourceId: string; jurisUrl: string };

/** The outside calls fetchOfficialText makes — a parameter so tests can fake them. */
export interface OfficialTextSources {
  law(lawId: string): Promise<LawSummary | null>;
  phFullText(lawId: string): Promise<string | null>;
  ukLegislationSection(args: { type: string; year: number; number: number; section: string }): Promise<string | null>;
  ukGrep(slug: string, pattern: string, maxHits: number): Promise<{ eId: string }[]>;
  ukParagraph(slug: string, eId: string): Promise<string | null>;
}

const realSources: OfficialTextSources = {
  law: (lawId) => LawRepo.findById(lawId),
  phFullText: async (lawId) => {
    // Imported here, not at the top: law.service pulls in the juris.ph client and its config,
    // which the pure helpers below don't need.
    const { default: LawSvc } = await import("../services/law.service");
    return LawSvc.fullTextFor(lawId);
  },
  ukLegislationSection: async (args) => (await legislationGetSection(args)).content || null,
  ukGrep: async (slug, pattern, maxHits) => (await grepJudgment(slug, pattern, maxHits, true)).hits,
  ukParagraph: async (slug, eId) => (await judgmentGetParagraph(slug, eId)).content || null,
};

/** Long enough for a paragraph or a statute section; short enough to read, and to hand to Jev. */
const MAX_PASSAGE_CHARS = 1500;
/** How long a citation check waits for the source before falling back to "not checked". */
export const OFFICIAL_TEXT_TIMEOUT_MS = 8000;

/** A crude stem, so "dismiss" finds "dismissed" and "employer" finds "employers". */
function stem(word: string): string {
  return word.slice(0, 6);
}

function contentStems(text: string): string[] {
  return [...new Set(tokens(text).filter((w) => w.length > 3 && !NEGATIONS.has(w)).map(stem))];
}

/** The candidate passages of a long text: each paragraph, or — for a paragraph longer than
 * maxChars (PDF text often has no paragraph breaks at all) — runs of consecutive sentences. */
function candidatePassages(text: string, maxChars: number): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\n\s*\n/)) {
    const paragraph = raw.replace(/\s+/g, " ").trim();
    if (!paragraph) continue;
    if (paragraph.length <= maxChars) {
      out.push(paragraph);
      continue;
    }
    const sentences = paragraph.split(/(?<=[.!?;:])\s+/);
    for (let i = 0; i < sentences.length; i++) {
      let window = "";
      for (let j = i; j < sentences.length; j++) {
        const next = window ? `${window} ${sentences[j]}` : sentences[j];
        if (next.length > maxChars) break;
        window = next;
      }
      if (window) out.push(window);
      else out.push(sentences[i].slice(0, maxChars));
    }
  }
  return out;
}

/**
 * The passage of `fullText` the quote is about, in the source's own words — or null when nothing
 * in it relates to the quote. Prefers a passage holding the quote exactly, then a near match
 * (matchQuote), then the one sharing most of the quote's words; shorter wins a tie.
 */
export function locatePassage(fullText: string, quote: string, maxChars = MAX_PASSAGE_CHARS): string | null {
  const wanted = contentStems(quote);
  if (wanted.length === 0) return null;

  let best: { passage: string; score: number } | null = null;
  for (const passage of candidatePassages(fullText, maxChars)) {
    const match = matchQuote(passage, quote);
    let score: number;
    if (match === "exact") score = 3;
    else if (match === "fuzzy") score = 2;
    else {
      const have = new Set(contentStems(passage));
      const hits = wanted.filter((w) => have.has(w)).length;
      if (hits < 2 || hits / wanted.length < 0.25) continue;
      score = hits / wanted.length;
    }
    if (!best || score > best.score || (score === best.score && passage.length < best.passage.length)) {
      best = { passage, score };
    }
  }
  return best?.passage ?? null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** A UK judgment paragraph (LegalDocML XML, as judgment_get_paragraph returns it) as plain text. */
export function stripLegalDocMl(xml: string): string {
  return xml
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole)
    .replace(/\s+/g, " ")
    .trim();
}

/** The quote's longest content words (ties in quote order) — the ones most likely to find the
 * right paragraph when the quote isn't in the judgment verbatim. */
export function distinctiveWords(quote: string, count = 3): string[] {
  const words = [...new Set(tokens(quote).filter((w) => w.length > 3 && !NEGATIONS.has(w)))];
  return words
    .map((word, order) => ({ word, order }))
    .sort((a, b) => b.word.length - a.word.length || a.order - b.order)
    .slice(0, count)
    .map(({ word }) => word);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function ukJudgmentText(slug: string, quote: string, title: string, sources: OfficialTextSources): Promise<FetchedOfficialText | null> {
  // Verbatim first: the cheapest, and exact when it hits.
  let eId = (await sources.ukGrep(slug, escapeRegex(quote.trim()), 1))[0]?.eId ?? null;

  if (!eId) {
    // Otherwise the paragraph most of the quote's distinctive words appear in.
    const counts = new Map<string, number>();
    for (const word of distinctiveWords(quote)) {
      for (const hit of await sources.ukGrep(slug, escapeRegex(word), 10)) {
        counts.set(hit.eId, (counts.get(hit.eId) ?? 0) + 1);
      }
    }
    let bestCount = 0;
    for (const [candidate, count] of counts) {
      if (count > bestCount) {
        eId = candidate;
        bestCount = count;
      }
    }
  }
  if (!eId) return null;

  const xml = await sources.ukParagraph(slug, eId);
  const text = xml ? stripLegalDocMl(xml) : "";
  if (!text) return null;
  const pinpoint = formatPinpointFromEid(eId);
  return { text: text.slice(0, MAX_PASSAGE_CHARS), source: "UK_JUDGMENT", ref: eId, pinpoint, label: `${title}, ${pinpoint}` };
}

async function fetchUntimed(
  input: { tenantCode: TenantCode; lawId: string; quote: string; ukSection?: string | null },
  sources: OfficialTextSources,
): Promise<FetchedOfficialText | null> {
  const law = await sources.law(input.lawId);
  if (!law) return null;

  if (input.tenantCode === "PH") {
    const fullText = await sources.phFullText(law.id);
    const text = fullText ? locatePassage(fullText, input.quote) : null;
    return text ? { text, source: "PH_LAW", ref: null, label: law.title } : null;
  }

  if (input.tenantCode === "UK") {
    const act = legislationUrlParts(law.jurisSourceId);
    if (act) {
      if (!input.ukSection) return null;
      const content = await sources.ukLegislationSection({ ...act, section: input.ukSection });
      if (!content) return null;
      const ref = `s. ${input.ukSection}`;
      const text = content.length > MAX_PASSAGE_CHARS ? (locatePassage(content, input.quote) ?? content.slice(0, MAX_PASSAGE_CHARS)) : content;
      return { text, source: "UK_LEGISLATION", ref, label: `${law.title}, ${ref}` };
    }
    const slug = extractCaseUri(law.jurisUrl);
    return slug ? ukJudgmentText(slug, input.quote, law.title, sources) : null;
  }

  return null;
}

/** The official text for a quote, from the authority it resolved to — or null when there's none
 * to be had (no source, a failed fetch, or the time limit). Never throws. */
export async function fetchOfficialText(
  input: { tenantCode: TenantCode; lawId: string; quote: string; ukSection?: string | null },
  sources: OfficialTextSources = realSources,
  timeoutMs = OFFICIAL_TEXT_TIMEOUT_MS,
): Promise<FetchedOfficialText | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      logger.warn("Official text fetch timed out", { lawId: input.lawId, tenantCode: input.tenantCode, timeoutMs });
      resolve(null);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      fetchUntimed(input, sources).catch((err) => {
        logger.warn("Official text fetch failed", { err, lawId: input.lawId, tenantCode: input.tenantCode });
        return null;
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
