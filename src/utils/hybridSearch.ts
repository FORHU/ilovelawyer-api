const MONTH = "(?:January|February|March|April|May|June|July|August|September|October|November|December)";

/** Exact-reference patterns a lawyer's question tends to hinge on. Each match becomes one
 * OR-ed search term; multi-token matches are searched as phrases. */
const ANCHOR_PATTERNS: RegExp[] = [
  /[“"]([^”"]{3,80})[”"]/g, // "senior management"
  /(?<!\w)[‘']([^’']{3,80})[’'](?!\w)/g, // ‘eleven days’ (not apostrophes)
  /\bD\d{2}(?:\.\d+)?\b/g, // D05, D20.3
  /\b[A-Z]{2,}(?:-[A-Z0-9]+)+\b/g, // TWDC-BW-07
  /\b[A-Z]{1,4}\d+[A-Z]?\b/g, // GC7, GC19, T2025
  /\b(?:ss?|regs?|cll?|paras?|arts?|r|rr)\.?\s?\d+[A-Za-z]?(?:\(\d+\))*(?:\.\d+)*/g, // s.37, cl. 4.9.4, paras 13
  /£\s?\d[\d,]*(?:\.\d+)?/g, // £1,842,500
  /\b\d{1,2}:\d{2}\b/g, // 02:40
  /\b\d+(?:\.\d+)+\b/g, // 10.6, 8.4.1.6
  /\b\d+(?:\.\d+)?%/g, // 61%
  new RegExp(`\\b\\d{1,2}\\s+${MONTH}(?:\\s+\\d{4})?\\b`, "g"), // 14 November 2023
  /\b(?:Mr|Mrs|Ms|Dr|Prof)\.?\s+[A-Z][\w'-]+(?:\s+[A-Z][\w'-]+)?/g, // Mr Pilbeam, Dr Ellis Vantrease
  /\b[A-Z][a-z]+(?:[-'][A-Z][a-z]+)?(?:\s+[A-Z][a-z]+(?:[-'][A-Z][a-z]+)?)+\b/g, // Halloway Brant, Pay Less Notice
];
const MAX_TERMS = 40;
const MIN_ANCHORS = 2;

export function extractAnchors(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const pattern of ANCHOR_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const term = (match[1] ?? match[0]).replace(/\s+/g, " ").trim();
      const key = term.toLowerCase();
      if (term.length < 2 || seen.has(key)) continue;
      seen.add(key);
      out.push(term);
      if (out.length >= MAX_TERMS) return out;
    }
  }
  return out;
}

/** Build the string handed to `websearch_to_tsquery`. Its default is AND-every-word, which a
 * multi-sentence question never satisfies against a single chunk, so we OR the exact references
 * the question cites — the lexical channel's job, since embeddings already cover semantics.
 *
 * A question citing fewer than MIN_ANCHORS references gets "" (vector-only) rather than an OR of
 * its content words. That fallback was actively harmful: "did the site manager know the scaffold
 * was unsafe" became `site OR manager OR know OR scaffold OR unsafe`, which matches nearly every
 * chunk of a construction bundle, and `ts_rank_cd` then ranks those by term density — i.e. by how
 * verbose a chunk is, not how relevant. When a question names no exact reference the lexical
 * channel has nothing to contribute and should stand down. */
export function buildLexicalQuery(text: string): string {
  const anchors = extractAnchors(text);
  if (anchors.length < MIN_ANCHORS) return "";
  return anchors.map((t) => (/[\s.()£:%-]/.test(t) ? `"${t.replace(/"/g, "")}"` : t)).join(" OR ");
}
