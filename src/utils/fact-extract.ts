export interface ExtractedFact {
  kind: "amount" | "date" | "fund";
  key: string;
  value: string;
  excerpt: string;
}

const AMOUNT_RE = /(?:PHP|PhP|P|₱)\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)/gi;
const ISO_DATE_RE = /\b(20[0-9]{2}|19[0-9]{2})[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12][0-9]|3[01])\b/g;
const LONG_DATE_RE =
  /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/gi;

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + length + 40);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function normalizeAmount(raw: string): string {
  return raw.replace(/,/g, "");
}

export function extractFacts(text: string): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(AMOUNT_RE)) {
    const value = normalizeAmount(match[1]);
    const key = `amount:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push({
      kind: "amount",
      key: "amount",
      value,
      excerpt: excerptAround(text, match.index ?? 0, match[0].length),
    });
  }

  for (const match of text.matchAll(ISO_DATE_RE)) {
    const value = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
    const key = `date:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push({
      kind: "date",
      key: "date",
      value,
      excerpt: excerptAround(text, match.index ?? 0, match[0].length),
    });
  }

  for (const match of text.matchAll(LONG_DATE_RE)) {
    const months: Record<string, string> = {
      january: "01",
      february: "02",
      march: "03",
      april: "04",
      may: "05",
      june: "06",
      july: "07",
      august: "08",
      september: "09",
      october: "10",
      november: "11",
      december: "12",
    };
    const value = `${match[3]}-${months[match[1].toLowerCase()]}-${match[2].padStart(2, "0")}`;
    const key = `date:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push({
      kind: "date",
      key: "date",
      value,
      excerpt: excerptAround(text, match.index ?? 0, match[0].length),
    });
  }

  return facts;
}

export interface ContradictionHit {
  kind: string;
  factKey: string;
  leftValue: string;
  rightValue: string;
  leftExcerpt: string;
  rightExcerpt: string;
  leftDocumentId: string;
  rightDocumentId: string;
  confidence: number;
}

export function findContradictions(
  left: { documentId: string; facts: ExtractedFact[] },
  right: { documentId: string; facts: ExtractedFact[] },
): ContradictionHit[] {
  if (left.documentId === right.documentId) return [];
  const hits: ContradictionHit[] = [];

  const rightByKind = new Map<string, ExtractedFact[]>();
  for (const fact of right.facts) {
    const list = rightByKind.get(fact.kind) ?? [];
    list.push(fact);
    rightByKind.set(fact.kind, list);
  }

  for (const lf of left.facts) {
    const candidates = rightByKind.get(lf.kind) ?? [];
    for (const rf of candidates) {
      if (lf.value === rf.value) continue;
      const kind = lf.kind === "amount" ? "amount_mismatch" : "date_mismatch";
      hits.push({
        kind,
        factKey: lf.kind,
        leftValue: lf.value,
        rightValue: rf.value,
        leftExcerpt: lf.excerpt,
        rightExcerpt: rf.excerpt,
        leftDocumentId: left.documentId,
        rightDocumentId: right.documentId,
        confidence: lf.kind === "amount" ? 0.7 : 0.6,
      });
    }
  }

  return hits;
}
