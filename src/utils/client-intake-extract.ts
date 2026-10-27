/**
 * ClientIntakeSvc's pure half: the prompt the AI sees, and parsing its reply into a CaseIntake
 * with every source resolved to a real message or document — anything that doesn't resolve is
 * dropped, never guessed at. Kept pure (no Prisma, no Chat Wonder call) so test/client-intake.spec.ts
 * can exercise it directly.
 *
 * Documents are cited the same way the lawyer-side AI panels do (case-document-handles.ts):
 * short handles (D1, D2, …) instead of raw ids, because a model garbles a 36-character id often
 * enough that most citations stopped matching. Messages get the same treatment here (M1, M2, …).
 */
import crypto from "crypto";
import { docsForPrompt, documentHandles, excerptsWithHandles, resolveDocumentRef, type CaseDoc } from "./case-document-handles";
import type { CaseIntake, IntakeSource } from "../types/client-intake";

export interface IntakeMessageInput {
  id: string;
  role: "user" | "ai";
  text: string;
  at: Date;
}

export interface IntakeDocumentInput {
  id: string;
  name: string;
}

/** M1…Mn in the order given, same idiom as documentHandles. */
function messageHandles(messages: IntakeMessageInput[]): Map<string, IntakeMessageInput> {
  return new Map(messages.map((m, i) => [`M${i + 1}`, m]));
}

function resolveMessageRef(raw: string, messages: IntakeMessageInput[]): string | null {
  const value = raw.trim().replace(/^\[|\]$/g, "").trim();
  const handle = /^m(\d+)$/i.exec(value);
  if (!handle) return null;
  const byHandle = [...messageHandles(messages)].find(([h]) => h.toLowerCase() === `m${handle[1]}`.toLowerCase());
  return byHandle?.[1].id ?? null;
}

const MAX_MESSAGES = 60;
const MAX_MESSAGE_CHARS = 1500;

/** The deterministic part of `people`: the parties the client entered on the case form.
 * CASE_DETAILS-sourced, never asked of the AI — see the contract's note on why: a form field is
 * already client-confirmed, so there's nothing to extract and nothing to get wrong. */
export function caseDetailsPeople(parties: { name: string; designation: string }[]): { name: string; role: string }[] {
  return parties.map((p) => ({ name: p.name, role: p.designation }));
}

export function buildIntakePrompt(input: {
  caseDetails: { title: string; practiceArea: string | null; ukJurisdiction: string | null; where: string | null; side: string | null; notes: string | null };
  parties: { name: string; designation: string }[];
  messages: IntakeMessageInput[];
  documents: IntakeDocumentInput[];
  documentExcerpts: string;
  today: string;
}): string {
  const msgs = input.messages.slice(-MAX_MESSAGES);
  const msgHandles = messageHandles(msgs);
  const chatLines = [...msgHandles]
    .map(([handle, m]) => `${handle} (${ukDay(m.at)}, ${m.role === "user" ? "client" : "AI"}): ${m.text.slice(0, MAX_MESSAGE_CHARS)}`)
    .join("\n\n");
  const docList = docsForPrompt(input.documents).map((d) => `${d.id}: ${d.name}`).join("\n") || "(none uploaded yet)";

  return `You are organising a client's intake conversation for a UK solicitor who has not read it yet. You are not giving legal advice and must not propose a legal strategy, predict an outcome, or recommend a course of action.

Today's date is ${input.today}.

Known case details (already confirmed by the client, do not repeat them as new facts):
Title: ${input.caseDetails.title}
Type of problem: ${input.caseDetails.practiceArea ?? "not set"}
Part of the UK: ${input.caseDetails.ukJurisdiction ?? "not set"}
Town or city: ${input.caseDetails.where ?? "not set"}
The client is: ${input.caseDetails.side === "CLAIMANT" ? "bringing the complaint" : input.caseDetails.side === "RESPONDENT" ? "responding to one" : "not set"}
The client's note: ${input.caseDetails.notes || "none"}
People already named on the case form (don't list these again under "people" unless the conversation adds new detail about them that isn't on the form): ${input.parties.map((p) => `${p.name} (${p.designation})`).join(", ") || "none"}

Documents on this case (cite by their handle, e.g. D1):
${docList}

Conversation (cite by its handle, e.g. M1):
${chatLines || "(no conversation yet)"}

From the conversation and the documents only — never invent or infer anything not stated — extract:
- people: anyone involved besides the client, who they are to the case (their role, e.g. "the employer", "a witness"), each with the message or document handle(s) it came from.
- timeline: dated events, each with a date (YYYY-MM-DD if a full date is given, or null if not), datePrecision ("DAY"/"MONTH"/"YEAR"/"UNKNOWN"), and its source handle(s). Never work out a date yourself — only use one that is actually stated or computable from a stated relative date ("last Tuesday") against today's date.
- facts: other important factual statements, each with its source handle(s).
- goals: what the client said they want to happen.
- concerns: what the client said they are worried about.
- questionsForLawyer: anything the client explicitly asked to have a lawyer answer, or clearly wants a lawyer's view on, including anything that would be legal advice.
- deadlines: a hearing, deadline or time limit, ONLY when a specific date or clearly stated time is actually given — never computed from a legal rule. Include the date if given (YYYY-MM-DD), else null, and say what was said.
- missing: open questions a solicitor would need answered that nothing above covers yet (no sources needed).
- conflicts: places where two or more sources disagree on a fact, date, or detail — each needs at least two source handles, one from each side of the disagreement.

Every item except "missing" must cite at least one real handle (Mn for the conversation, Dn p.N for a document, with the page if you can tell which page). Never cite a handle that doesn't exist. Do not repeat the known case details above as if you'd found them in the conversation.

${input.documentExcerpts}

Reply with only this JSON and nothing else, omitting a list entirely (as []) when there's nothing to put in it:
{"summary": "80-150 words, plain English, neutral, third person, no legal conclusions", "people": [{"name": "", "role": "", "sources": ["M1"]}], "timeline": [{"text": "", "date": null, "datePrecision": "UNKNOWN", "sources": ["M2"]}], "facts": [{"text": "", "sources": ["M1"]}], "goals": [{"text": "", "sources": ["M1"]}], "concerns": [{"text": "", "sources": ["M1"]}], "questionsForLawyer": [{"text": "", "sources": ["M1"]}], "deadlines": [{"text": "", "date": null, "sources": ["M1"]}], "missing": [{"question": "", "why": ""}], "conflicts": [{"description": "", "sources": ["M1", "D1 p.2"]}]}`;
}

/** A day as the client sees it, UK time (same rule as client-request-brief.service.ts's ukDay). */
function ukDay(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

interface RawSourced {
  sources?: unknown;
}

function parseSourceHandle(raw: unknown, docs: CaseDoc[], messages: IntakeMessageInput[]): IntakeSource | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  const pageMatch = /^(.+?)\s+p\.?\s*(\d+)$/i.exec(value);
  const ref = pageMatch ? pageMatch[1]! : value;
  const page = pageMatch ? Number(pageMatch[2]) : null;

  const docId = resolveDocumentRef(ref, docs);
  if (docId) {
    const doc = docs.find((d) => d.id === docId)!;
    return { kind: "DOCUMENT", messageId: null, documentId: docId, documentName: doc.name, page: Number.isInteger(page) && page! > 0 ? page : null };
  }
  const msgId = resolveMessageRef(ref, messages);
  if (msgId) return { kind: "CLIENT", messageId: msgId, documentId: null, documentName: null, page: null };
  return null;
}

function parseSources(raw: RawSourced, docs: CaseDoc[], messages: IntakeMessageInput[]): IntakeSource[] {
  const list = Array.isArray(raw.sources) ? raw.sources : [];
  const resolved = list.map((s) => parseSourceHandle(s, docs, messages)).filter((s): s is IntakeSource => s !== null);
  const seen = new Set<string>();
  return resolved.filter((s) => {
    const key = `${s.kind}:${s.messageId ?? ""}:${s.documentId ?? ""}:${s.page ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A stable id for one extracted item: the same text and kind always gets the same id, so a
 * re-run that finds the same things doesn't reshuffle what the client has already seen linked
 * from the chat or a document. */
function stableId(kind: string, text: string): string {
  return crypto.createHash("sha1").update(`${kind}:${text.trim().toLowerCase()}`).digest("hex").slice(0, 16);
}

const MAX_LIST = 40;

/** The same text (or name) twice gets the same stable id, which breaks list keys downstream. Keeps
 * the first and folds the later ones' sources into it, so nothing the AI cited is lost. */
function dedupe<T extends { id: string; sources?: IntakeSource[] }>(items: T[]): T[] {
  const seen = new Map<string, T>();
  for (const item of items) {
    const first = seen.get(item.id);
    if (!first) {
      seen.set(item.id, item);
      continue;
    }
    if (first.sources && item.sources) {
      const known = new Set(first.sources.map((s) => JSON.stringify(s)));
      for (const s of item.sources) if (!known.has(JSON.stringify(s))) first.sources.push(s);
    }
  }
  return [...seen.values()];
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export interface ParsedIntake {
  summary: string | null;
  people: CaseIntake["people"];
  timeline: CaseIntake["timeline"];
  facts: CaseIntake["facts"];
  goals: CaseIntake["goals"];
  concerns: CaseIntake["concerns"];
  questionsForLawyer: CaseIntake["questionsForLawyer"];
  deadlines: CaseIntake["deadlines"];
  missing: CaseIntake["missing"];
  conflicts: CaseIntake["conflicts"];
}

/** Parses the AI's JSON reply. Returns null when there's nothing usable at all (no summary and no
 * extracted lists) — the caller then keeps whatever was there before. Every source is resolved
 * against the real documents/messages this run was built from; a handle that matches none is
 * dropped. An item left with no sources is dropped too, except `missing` (never sourced) and the
 * top-level `summary`. A conflict needs at least two surviving sources, or it's dropped: a single
 * source can't itself be a disagreement. */
export function parseIntakeReply(reply: string, docs: CaseDoc[], messages: IntakeMessageInput[]): ParsedIntake | null {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }

  const summary = str(parsed.summary) || null;

  const peopleAll = arr(parsed.people)
    .map((raw): CaseIntake["people"][number] | null => {
      const name = str(raw.name);
      if (!name) return null;
      const sources = parseSources(raw, docs, messages);
      if (!sources.length) return null;
      const role = str(raw.role) || "involved";
      return { id: stableId("person", name), name, role, text: role, sources };
    })
    .filter((x): x is CaseIntake["people"][number] => x !== null);
  const people = dedupe(peopleAll).slice(0, MAX_LIST);

  const timelineAll = arr(parsed.timeline)
    .map((raw): CaseIntake["timeline"][number] | null => {
      const text = str(raw.text);
      if (!text) return null;
      const sources = parseSources(raw, docs, messages);
      if (!sources.length) return null;
      const date = plausibleIsoDate(raw.date);
      const precision = (["DAY", "MONTH", "YEAR", "UNKNOWN"] as const).includes(raw.datePrecision as never) ? (raw.datePrecision as CaseIntake["timeline"][number]["datePrecision"]) : "UNKNOWN";
      return { id: stableId("event", text), text, date, datePrecision: date ? precision : "UNKNOWN", sources };
    })
    .filter((x): x is CaseIntake["timeline"][number] => x !== null);
  const timeline = dedupe(timelineAll)
    .sort((a, b) => (a.date && b.date ? a.date.localeCompare(b.date) : a.date ? -1 : b.date ? 1 : 0))
    .slice(0, MAX_LIST);

  const simpleList = (key: string, kind: string) =>
    dedupe(arr(parsed[key])
      .map((raw): CaseIntake["facts"][number] | null => {
        const text = str(raw.text);
        if (!text) return null;
        const sources = parseSources(raw, docs, messages);
        if (!sources.length) return null;
        return { id: stableId(kind, text), text, sources };
      })
      .filter((x): x is CaseIntake["facts"][number] => x !== null))
      .slice(0, MAX_LIST);

  const facts = simpleList("facts", "fact");
  const goals = simpleList("goals", "goal");
  const concerns = simpleList("concerns", "concern");
  const questionsForLawyer = simpleList("questionsForLawyer", "question");

  const deadlinesAll = arr(parsed.deadlines)
    .map((raw): CaseIntake["deadlines"][number] | null => {
      const text = str(raw.text);
      if (!text) return null;
      const sources = parseSources(raw, docs, messages);
      if (!sources.length) return null;
      return { id: stableId("deadline", text), text, date: plausibleIsoDate(raw.date), sources };
    })
    .filter((x): x is CaseIntake["deadlines"][number] => x !== null);
  const deadlines = dedupe(deadlinesAll).slice(0, MAX_LIST);

  const missingAll = arr(parsed.missing)
    .map((raw): CaseIntake["missing"][number] | null => {
      const question = str(raw.question);
      if (!question) return null;
      return { id: stableId("gap", question), question, why: str(raw.why) };
    })
    .filter((x): x is CaseIntake["missing"][number] => x !== null);
  const missing = dedupe(missingAll).slice(0, MAX_LIST);

  const conflictsAll = arr(parsed.conflicts)
    .map((raw): CaseIntake["conflicts"][number] | null => {
      const description = str(raw.description);
      if (!description) return null;
      const sources = parseSources(raw, docs, messages);
      if (sources.length < 2) return null;
      return { id: stableId("conflict", description), description, sources };
    })
    .filter((x): x is CaseIntake["conflicts"][number] => x !== null);
  const conflicts = dedupe(conflictsAll).slice(0, MAX_LIST);

  const nothingUsable = !summary && ![people, timeline, facts, goals, concerns, questionsForLawyer, deadlines, missing, conflicts].some((l) => l.length);
  if (nothingUsable) return null;

  return { summary, people, timeline, facts, goals, concerns, questionsForLawyer, deadlines, missing, conflicts };
}

function arr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PAST_DAYS = 3650;
const MAX_AHEAD_DAYS = 3650;

/** A real calendar date, not implausibly far from now — same guard as
 * client-request-brief.service.ts's plausibleDeadline, generalised to any extracted date. */
function plausibleIsoDate(value: unknown, now: Date = new Date()): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const at = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== value) return null;
  const days = Math.round((at.getTime() - Date.parse(`${ukDay(now)}T00:00:00Z`)) / DAY_MS);
  return days < -MAX_PAST_DAYS || days > MAX_AHEAD_DAYS ? null : value;
}

export { documentHandles, excerptsWithHandles };
