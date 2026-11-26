/**
 * The evidence step's pure half (ClientEvidenceSvc): the prompt that has Chat Wonder suggest the
 * proof a case would benefit from, from the client's story and answers, and parsing its reply. No
 * Prisma, no Chat Wonder call, so test/client-evidence.spec.ts exercises it directly.
 *
 * Same language rule as the questions (client-questions-plan.ts): the server names the story's
 * language, and anything that comes back in another is left out; too few left, and the app's own
 * general suggestions are used.
 */
import type { TenantCode } from "../types/tenant-code";
import { fitsLanguage, type PlanLanguage } from "./client-questions-plan";

/** How a proof is best added, and so which button its card shows. */
export const EVIDENCE_SOURCES = ["photos", "files", "email", "memo"] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

export const MIN_SUGGESTIONS = 2;
export const MAX_SUGGESTIONS = 5;
const TITLE_MAX_CHARS = 80;
const WHY_MAX_CHARS = 200;

export interface EvidenceSuggestion {
  title: string;
  why: string;
  source: EvidenceSource;
}

const LANGUAGE_NAME: Record<PlanLanguage, string> = { en: "English", ko: "Korean" };

/** The app's own suggestions, for when the AI's are missing or unusable: general proof most cases
 * have, rather than none. */
const GENERAL: Record<PlanLanguage, EvidenceSuggestion[]> = {
  en: [
    { title: "Messages with the other side", why: "Shows what was said, and when.", source: "email" },
    { title: "Any contract or written agreement", why: "Shows what was agreed.", source: "files" },
    { title: "Photos of anything relevant", why: "Shows what happened.", source: "photos" },
  ],
  ko: [
    { title: "상대방과 주고받은 메시지", why: "언제 무슨 말이 오갔는지 보여 줘요.", source: "email" },
    { title: "계약서나 서면 합의서", why: "무엇을 약속했는지 보여 줘요.", source: "files" },
    { title: "관련된 사진", why: "무슨 일이 있었는지 보여 줘요.", source: "photos" },
  ],
};

export function generalSuggestions(language: PlanLanguage): EvidenceSuggestion[] {
  return GENERAL[language].map((s) => ({ ...s }));
}

export function buildEvidencePrompt(input: {
  tenantCode: TenantCode;
  /** caseDetailsBlock's text. */
  caseDetails: string;
  /** The story, then the questions and answers (conversationLines). */
  conversation: string;
  /** Documents already on the case, by name: never suggested again. */
  documents: string[];
  today: string;
  language: PlanLanguage;
}): string {
  const language = LANGUAGE_NAME[input.language];
  return `You are helping a client gather proof for their legal problem, before a lawyer reads it. You are not giving legal advice and must not predict an outcome, name a law, or say what the client should do.

Today's date is ${input.today}.

${input.caseDetails}

What the client has told us (their story first, then their answers to our questions):
${input.conversation || "(none)"}

Documents already on the case: ${input.documents.length ? input.documents.join(", ") : "none"}

Suggest ${MIN_SUGGESTIONS} to ${MAX_SUGGESTIONS} pieces of proof this client probably has, or can easily get, that would back up what they told us: documents, messages, photos or recordings. Only things that follow from what they said (a payslip when pay is owed, the tenancy agreement when it's about a deposit, messages from the person who dismissed them). Never something already on the case, never something they'd have to get from the other side, and never anything only a lawyer could obtain.

Write everything in ${language} only, because the client told their story in ${language}. Never use any other language or script.

For each:
- title: what it is, in the client's own words, at most 6 words (for example "Payslips", "Messages from your manager").
- why: one short sentence saying what it shows about their case, in plain everyday words with no legal terms. Never a legal conclusion or a likely outcome.
- source: how it's best added: "photos" (something on paper or a screen to photograph), "files" (a document they have as a file), "email" (emails), or "memo" (something only they remember, best recorded as a voice memo).

Most useful first. Reply with only this JSON and nothing else:
{"suggestions": [{"title": "", "why": "", "source": "photos"}]}`;
}

/** A drafted note longer than this isn't a short note; it's dropped (the client writes their own). */
export const NOTE_MAX_CHARS = 400;
/** What the prompt asks for: well under NOTE_MAX_CHARS, which leaves room for a model that runs a
 * little long (a note of two full sentences is often 250 characters). */
export const NOTE_TARGET_CHARS = 250;

/** The note on one document the client added: what it is and what it shows, in their words. */
export function buildNotePrompt(input: {
  name: string;
  category: string | null;
  /** What was read from it (its text, or a photo's description), already cut short. */
  content: string;
  /** The suggestion it fills, when it was added for one ("Payslips"). */
  fills: string | null;
  /** The client's story, for who's who and the dates. */
  story: string;
  language: PlanLanguage;
}): string {
  const language = LANGUAGE_NAME[input.language];
  return `A client has added a document to their legal case. Write the short note they'd write about it: what it is and what it shows about their case, so their lawyer understands it at a glance.

Their story: ${input.story || "(none)"}

The document: ${input.name}${input.category ? ` (${input.category})` : ""}${input.fills ? `, added as: ${input.fills}` : ""}
What it says:
${input.content || "(nothing could be read from it)"}

Write one or two short sentences, ${NOTE_TARGET_CHARS} characters at most, in ${language} only, in the first person as the client ("My last payslip, for December 2025."), in plain everyday words with no legal terms, saying only what the document itself shows. Never a legal conclusion, an outcome, or advice. When nothing could be read from it, give an empty note.

Reply with only this JSON and nothing else:
{"note": ""}`;
}

/** A note longer than NOTE_MAX_CHARS kept to its whole sentences that fit; null when even the first
 * doesn't. A long note is never thrown away whole: the document would be marked as tried and never
 * get one. */
export function fitNote(note: string): string | null {
  if (note.length <= NOTE_MAX_CHARS) return note;
  const head = note.slice(0, NOTE_MAX_CHARS + 1);
  // The last sentence end (a full stop, question or exclamation mark) inside the limit.
  const ends = [...head.matchAll(/[.!?\u3002](?=\s|$)/g)].map((m) => (m.index ?? 0) + 1).filter((i) => i <= NOTE_MAX_CHARS);
  return ends.length ? note.slice(0, ends[ends.length - 1]).trim() : null;
}

/** Why a reply gave no note, for the log (never the note itself, which is the client's). */
export type NoteDiscard = "no-json" | "empty" | "too-long" | "wrong-language";

/** The drafted note, or null with why: no JSON, empty, too long even cut to its sentences, or in
 * another language than the case's. */
export function readNoteReply(reply: string, language: PlanLanguage): { note: string } | { note: null; why: NoteDiscard } {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return { note: null, why: "no-json" };
  let raw: string;
  try {
    raw = str((JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>).note);
  } catch {
    return { note: null, why: "no-json" };
  }
  if (!raw) return { note: null, why: "empty" };
  const note = fitNote(raw);
  if (!note) return { note: null, why: "too-long" };
  if (!fitsLanguage(note, language)) return { note: null, why: "wrong-language" };
  return { note };
}

/** The drafted note, or null: none, too long, or in another language than the case's. */
export function parseNoteReply(reply: string, language: PlanLanguage): string | null {
  return readNoteReply(reply, language).note;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
}

/**
 * Parses the AI's reply into at most MAX_SUGGESTIONS suggestions, in its order: each with a title
 * and a why in `language`, a known source ("files" when it gave none it could use), and no title
 * twice. Fewer than MIN_SUGGESTIONS usable (or no JSON at all) means the app's general suggestions.
 */
export function parseEvidenceReply(reply: string, language: PlanLanguage): { suggestions: EvidenceSuggestion[]; fromAi: boolean } {
  const fallback = { suggestions: generalSuggestions(language), fromAi: false };
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return fallback;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return fallback;
  }

  const suggestions: EvidenceSuggestion[] = [];
  for (const raw of Array.isArray(parsed.suggestions) ? parsed.suggestions : []) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const title = str(r.title);
    const why = str(r.why);
    if (!title || title.length > TITLE_MAX_CHARS || !fitsLanguage(title, language)) continue;
    if (suggestions.some((s) => s.title.toLowerCase() === title.toLowerCase())) continue;
    const source = (EVIDENCE_SOURCES as readonly string[]).includes(str(r.source)) ? (str(r.source) as EvidenceSource) : "files";
    const whyFits = why && why.length <= WHY_MAX_CHARS && fitsLanguage(why, language);
    suggestions.push({ title, why: whyFits ? why : "", source });
    if (suggestions.length === MAX_SUGGESTIONS) break;
  }
  return suggestions.length >= MIN_SUGGESTIONS ? { suggestions, fromAi: true } : fallback;
}

// ---- The saved suggestions, as the client and the engaged lawyer see them --------------------

/** One suggested proof, as the evidence screen shows it (and the engaged lawyer's package). */
export interface EvidenceSuggestionView {
  /** The gap's id: an upload that fills it sends it as missingEvidenceId. */
  id: string;
  title: string;
  why: string;
  source: EvidenceSource;
  /** ADDED once a document fills it; DISMISSED when the client said they don't have it. */
  state: "OPEN" | "ADDED" | "DISMISSED";
  documentId: string | null;
}

export interface EvidenceState {
  suggestions: EvidenceSuggestionView[];
  /** How many suggestions a document fills. */
  added: number;
  /** How many are still waiting for something. */
  open: number;
}

/** A saved suggestion: a CaseMissingEvidence row marked CLIENT_INTAKE. */
export interface EvidenceSuggestionRow {
  id: string;
  label: string;
  detail: string | null;
  suggestedSource: string | null;
  filledByDocumentId: string | null;
  clientDismissedAt: Date | null;
}

const SOURCES: readonly string[] = EVIDENCE_SOURCES;

export function evidenceStateOf(rows: EvidenceSuggestionRow[]): EvidenceState {
  const suggestions = rows.map(
    (row): EvidenceSuggestionView => ({
      id: row.id,
      title: row.label,
      why: row.detail ?? "",
      source: (SOURCES.includes(row.suggestedSource ?? "") ? row.suggestedSource : "files") as EvidenceSource,
      // A filled one counts as added even if the client had said they didn't have it.
      state: row.filledByDocumentId ? "ADDED" : row.clientDismissedAt ? "DISMISSED" : "OPEN",
      documentId: row.filledByDocumentId,
    }),
  );
  return {
    suggestions,
    added: suggestions.filter((s) => s.state === "ADDED").length,
    open: suggestions.filter((s) => s.state === "OPEN").length,
  };
}
