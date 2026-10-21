/**
 * Takes identifying details out of the anonymised case brief (#508) before any lawyer sees it.
 * The AI is asked to write without names, but this is the guarantee: it doesn't depend on the AI
 * following instructions. Pure and deterministic, so test/client-request-brief.spec.ts can prove
 * nothing leaks.
 *
 * Removed: every party's name (and the parts of it that identify them), the client's own name,
 * document names, email addresses, phone numbers and UK postcodes.
 */

export interface RedactionContext {
  /** Each name with what to say instead, e.g. { name: "Acme Ltd", label: "the other side" }. */
  people: { name: string; label: string }[];
  documentNames: string[];
}

/** Words in a name that identify nobody on their own, so they're never replaced alone. */
const GENERIC_NAME_WORDS = new Set([
  "the", "and", "of", "for", "ltd", "limited", "plc", "llp", "llc", "inc", "co", "corp", "corporation",
  "group", "holdings", "company", "services", "uk", "mr", "mrs", "ms", "miss", "dr", "sir",
]);

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The whole name, plus each distinctive word of it ("John Smith": "John", "Smith"). A lone word
 * is matched only when capitalised, as a name would be, so "Rose" goes but "rose" stays. */
function nameVariants(name: string): { pattern: RegExp; length: number }[] {
  const full = name.trim();
  if (full.length < 2) return [];
  const variants = [{ pattern: new RegExp(`(?<![\\w])${escapeRegExp(full)}(?![\\w])`, "gi"), length: full.length }];
  for (const word of full.split(/[\s,.&'()/-]+/)) {
    if (word.length < 3 || GENERIC_NAME_WORDS.has(word.toLowerCase()) || !/^[A-Z]/.test(word)) continue;
    variants.push({ pattern: new RegExp(`(?<![\\w])${escapeRegExp(word)}(?![\\w])`, "g"), length: word.length });
  }
  return variants;
}

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const UK_POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/gi;
/** A run of digits and phone punctuation. Kept only if it has at least 10 digits, so dates
 * ("2026-10-21") and money ("£12,500") survive. */
const PHONE_LIKE = /\+?\(?\d[\d\s().-]{7,}\d/g;

export function redactBrief(text: string, ctx: RedactionContext): string {
  let out = text;

  // Longest first, so "John Smith" goes before "John" and leaves no stray half.
  const replacements = ctx.people.flatMap((p) => nameVariants(p.name).map((v) => ({ ...v, label: p.label })));
  for (const name of ctx.documentNames) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    replacements.push({ pattern: new RegExp(escapeRegExp(trimmed), "gi"), length: trimmed.length, label: "a document" });
    const stem = trimmed.replace(/\.[a-z0-9]{2,5}$/i, "");
    if (stem !== trimmed && stem.length >= 4) replacements.push({ pattern: new RegExp(escapeRegExp(stem), "gi"), length: stem.length, label: "a document" });
  }
  replacements.sort((a, b) => b.length - a.length);
  for (const r of replacements) out = out.replace(r.pattern, r.label);

  out = out.replace(EMAIL, "[email removed]");
  out = out.replace(UK_POSTCODE, "[postcode removed]");
  out = out.replace(PHONE_LIKE, (match) => ((match.match(/\d/g)?.length ?? 0) >= 10 ? "[phone removed]" : match));
  return out;
}

/** How each kind of party in the client app is referred to in the brief. */
export function labelForDesignation(designation: string): string {
  switch (designation) {
    case "Opposing party":
      return "the other side";
    case "Witness":
      return "a witness";
    default:
      return "another person involved";
  }
}
