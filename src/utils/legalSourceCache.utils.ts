import { KNOWN_CODES } from "../constants/legalSourceCache.constants";

export function normalizeKeyword(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[`'""'']/g, "")
    .replace(/\bof\s+the\s+philippines\b/g, "")
    .replace(/\bart\b\.?/g, "article")
    .replace(/\bno\b\.?/g, "")
    .replace(/\((\d{4})\)/g, "$1")
    .replace(/\blaw\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function cleanAiText(text: string): string {
  if (!text) return text;
  return text
    .replace(/__END__$/g, "")
    .replace(/\[Sources\][\s\S]*$/i, "")
    .replace(/\[TIMELINE\][\s\S]*?\[\/TIMELINE\]/gi, "")
    .replace(/\[MINDMAP\][\s\S]*?\[\/MINDMAP\]/gi, "")
    .replace(/\[RELATED_QUERIES\][\s\S]*?\[\/RELATED_QUERIES\]/gi, "")
    .replace(/\[ILM_META\][\s\S]*?\[\/ILM_META\]/gi, "")
    .replace(/\[HIDDEN_INSTRUCTION\][\s\S]*?\[\/HIDDEN_INSTRUCTION\]/gi, "")
    .trim();
}

export function extractYearHint(rawKeyword: string): number | null {
  const m = rawKeyword.match(/\((\d{4})\)/);
  if (m) return parseInt(m[1], 10);
  const m2 = rawKeyword.match(/\b(19\d{2}|20\d{2})\b/);
  return m2 ? parseInt(m2[1], 10) : null;
}

export function extractRagSearchTerms(keyword: string): string[] {
  const terms: string[] = [];

  const articleMatch = keyword.match(/article\s+(\d+)/i);
  if (articleMatch) terms.push(`Article ${articleMatch[1]}`);

  const sectionMatch = keyword.match(/section\s+(\d+)/i);
  if (sectionMatch) terms.push(`Section ${sectionMatch[1]}`);

  for (const code of KNOWN_CODES) {
    if (keyword.toLowerCase().includes(code.toLowerCase())) {
      terms.push(code);
      break;
    }
  }

  const raMatch = keyword.match(/republic act\s+(?:no\.?\s*)?(\d+)/i);
  if (raMatch) { terms.push("Republic Act"); terms.push(raMatch[1]); }

  const pdMatch = keyword.match(/presidential decree\s+(?:no\.?\s*)?(\d+)/i);
  if (pdMatch) { terms.push("Presidential Decree"); terms.push(pdMatch[1]); }

  return terms;
}
