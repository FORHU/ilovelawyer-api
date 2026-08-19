export type CitationValidityStatus = "VALID" | "INVALID" | "UNVERIFIED" | "ADVERSE";

export interface CitationCheckInput {
  quotedText: string;
  officialText?: string | null;
  citedReference?: string | null;
}

export interface CitationCheckResult {
  status: CitationValidityStatus;
  notes: string;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[“”"']/g, "")
    .trim();
}

function containsQuote(official: string, quote: string): boolean {
  const hay = normalize(official);
  const needle = normalize(quote);
  if (needle.length < 12) return hay.includes(needle);
  if (hay.includes(needle)) return true;
  const words = needle.split(" ").filter((w) => w.length > 3);
  if (words.length < 4) return false;
  const hits = words.filter((w) => hay.includes(w)).length;
  return hits / words.length >= 0.85;
}

export function evaluateCitation(input: CitationCheckInput): CitationCheckResult {
  const quote = input.quotedText?.trim() ?? "";
  if (!quote) {
    return { status: "UNVERIFIED", notes: "No quotation supplied." };
  }

  const official = input.officialText?.trim() ?? "";
  if (!official) {
    return {
      status: "UNVERIFIED",
      notes: "No official text available to verify the quotation against. Do not treat this citation as confirmed.",
    };
  }

  if (containsQuote(official, quote)) {
    return {
      status: "VALID",
      notes: "Quoted language appears in the official text (normalized match). Lawyer should still confirm current validity.",
    };
  }

  return {
    status: "INVALID",
    notes: "Quoted language was not found in the official text. Possible false citation.",
  };
}
