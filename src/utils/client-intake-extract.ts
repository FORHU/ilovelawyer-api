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
import type { CaseIntake, IntakeEvent, IntakeFormFields, IntakeItem, IntakePerson, IntakeSource, IntakeStoryLine } from "../types/client-intake";
import { CLIENT_STORY_MAX_LENGTH } from "../constants/client-case.constants";

export interface IntakeMessageInput {
  id: string;
  role: "user" | "ai";
  text: string;
  at: Date;
}

export interface IntakeDocumentInput {
  id: string;
  name: string;
  /** The client's note on it (the evidence step), opened; shown beside its name. */
  note?: string | null;
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

/** "Here's your story so far" shows at most this many lines. */
export const STORY_SO_FAR_MAX = 5;
/** A story line longer than this isn't a line the screen can show; it's dropped, not cut, so its
 * bold markers never come apart. */
const STORY_LINE_MAX_CHARS = 300;
/** A suggested case title, cut at a word beyond this. */
export const SUGGESTED_TITLE_MAX = 80;
/** At most this many suggested case areas. */
const SUGGESTED_AREAS_MAX = 2;

/** Cuts `text` at a word to at most `max` characters. */
function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim();
}

/** The placeholder title a case made from a story starts with (ClientStorySvc), until the
 * extraction suggests a better one: the story's first sentence, cut at a word. */
export function storyTitle(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "New case";
  const sentence = flat.match(/^.+?[.!?。](?=\s|$)/)?.[0] ?? flat;
  if (sentence.length <= SUGGESTED_TITLE_MAX) return sentence.replace(/[.!?。]$/, "");
  return cutAtWord(sentence, SUGGESTED_TITLE_MAX);
}

/** The case still has the details it was made with from a story (ClientStorySvc): its only area
 * is `otherCode` and its title is still the one cut from the client's first message. Only then may
 * the AI's suggested title and areas replace them, so nothing the client chose or edited is ever
 * overwritten. A case made any other way (the form, the chat's first message) has a different
 * title from the start, so it never matches. */
export function hasStoryPlaceholderDetails(caseDetails: { title: string; caseAreaCodes: string[] }, firstMessage: string | null, otherCode: string): boolean {
  return (
    firstMessage !== null &&
    caseDetails.title === storyTitle(firstMessage) &&
    caseDetails.caseAreaCodes.length === 1 &&
    caseDetails.caseAreaCodes[0] === otherCode
  );
}

/** The deterministic part of `people`: the parties the client entered on the case form.
 * CASE_DETAILS-sourced, never asked of the AI — see the contract's note on why: a form field is
 * already client-confirmed, so there's nothing to extract and nothing to get wrong. */
export function caseDetailsPeople(parties: { name: string; designation: string }[]): { name: string; role: string }[] {
  return parties.map((p) => ({ name: p.name, role: p.designation }));
}

/** Matches only because buildIntakePrompt's "people" instruction now requires the literal word
 * "witness" in `role` for anyone who observed events without being a party to the claim — this
 * regex and that prompt wording are one contract, not two independent guesses. Before that
 * instruction existed, this matched whatever free-text role the model happened to write (e.g.
 * "coworker", "bystander"), which silently misfiled real witnesses into `parties` instead of just
 * missing them — the filter below is "not witness", so a false negative here isn't a gap, it's a
 * wrong bucket. */
const WITNESS_ROLE = /witness/i;

/** #157: the ticket's named field groups, derived from data ClientIntakeSvc already has — not a
 * second AI call. parties/typeOfAction/venue are the deterministic case-creation form data (never
 * guessed); witnesses/timeline/clientGoals/relationship/roleAndTerms/reasonGiven are the already-
 * extracted people/timeline/goals/relationship/roleAndTerms/reasonGiven, split out and relabeled
 * for the question-loop UI. relationship/roleAndTerms/reasonGiven are generic across practice
 * areas (not employment-specific), per the ticket's screenshot: e.g. "tenant and landlord" /
 * "contract value and deliverables" / "the reason the other side gave" read just as naturally for
 * a housing or contract case as for a dismissal. */
export function deriveFormFields(input: {
  people: IntakePerson[];
  timeline: IntakeEvent[];
  goals: IntakeItem[];
  relationship: IntakeItem[];
  roleAndTerms: IntakeItem[];
  reasonGiven: IntakeItem[];
  typeOfAction: string[];
  venue: string | null;
}): IntakeFormFields {
  const parties = input.people.filter((p) => !WITNESS_ROLE.test(p.role));
  const witnesses = input.people.filter((p) => WITNESS_ROLE.test(p.role));
  const missing: IntakeFormFields["missing"] = [];
  if (!parties.length) missing.push("parties");
  if (!witnesses.length) missing.push("witnesses");
  if (!input.typeOfAction.length) missing.push("typeOfAction");
  if (!input.venue) missing.push("venue");
  if (!input.timeline.length) missing.push("timeline");
  if (!input.goals.length) missing.push("clientGoals");
  if (!input.relationship.length) missing.push("relationship");
  if (!input.roleAndTerms.length) missing.push("roleAndTerms");
  if (!input.reasonGiven.length) missing.push("reasonGiven");
  return {
    parties,
    witnesses,
    typeOfAction: input.typeOfAction,
    venue: input.venue,
    timeline: input.timeline,
    clientGoals: input.goals,
    relationship: input.relationship,
    roleAndTerms: input.roleAndTerms,
    reasonGiven: input.reasonGiven,
    missing,
  };
}

/** What the client already answered on the case-creation form — shared between
 * ClientIntakeSvc's extraction prompt (buildIntakePrompt below) and IntakeChatSvc's conversational
 * grounding (sent to chat-wonder as part of document_context), so a client never has to repeat a
 * wizard answer to the chat itself. Same wording in both places by construction, not by convention.
 *
 * `ukCase` false (a client case on another site, e.g. KR) leaves out the "Part of the UK" line: it
 * would only ever read "not set" there, which the UK intake treats as a question still to ask. */
export function caseDetailsBlock(
  caseDetails: { title: string; caseAreas: string[]; ukJurisdiction: string | null; outsideUk?: boolean; where: string | null; side: string | null; notes: string | null },
  parties: { name: string; designation: string }[],
  ukCase = true,
): string {
  const partOfUk = ukCase ? `\nPart of the UK: ${caseDetails.ukJurisdiction ?? (caseDetails.outsideUk ? "outside the UK (the client said so)" : "not set")}` : "";
  return `Known case details (already confirmed by the client, do not repeat them as new facts):
Title: ${caseDetails.title}
Type of problem: ${caseDetails.caseAreas.join(", ") || "not set"}${partOfUk}
Town or city: ${caseDetails.where ?? "not set"}
The client is: ${caseDetails.side === "CLAIMANT" ? "bringing the complaint" : caseDetails.side === "RESPONDENT" ? "responding to one" : "not set"}
The client's note: ${caseDetails.notes || "none"}
People already named on the case form (don't list these again under "people" unless the conversation adds new detail about them that isn't on the form): ${parties.map((p) => `${p.name} (${p.designation})`).join(", ") || "none"}`;
}

/** Jev's own independent readiness check (lawyer-readiness-jev.ts) already decides, every turn,
 * whether each must-have is covered — the same verdict the client's own readiness checklist UI
 * shows. Feeding that verdict back into chat-wonder's context turns "is this already answered"
 * from the model re-deriving it by re-reading raw chat text (unreliable over a long conversation)
 * into a lookup against ground truth it's explicitly told to trust.
 *
 * Lists both sides, not just what's confirmed: a live bug (2026-11-03) showed the model treating
 * a case as finished in prose ("ready for a solicitor to review") while an independent-check
 * must-have was still unmet, and never asking for it — surfacing only the confirmed half gave it
 * nothing telling it to keep pursuing the rest. Empty string when there's nothing to say either
 * way (nothing confirmed and nothing outstanding — i.e. no criteria at all, such as Jev disabled),
 * not an empty-looking block. */
export function readinessBlock(criteria: { label: string; met: boolean }[]): string {
  const met = criteria.filter((c) => c.met).map((c) => `- ${c.label}`);
  const open = criteria.filter((c) => !c.met).map((c) => `- ${c.label}`);
  if (!met.length && !open.length) return "";
  const parts: string[] = [];
  if (met.length) {
    parts.push(`Already confirmed by an independent check — do not ask about these again, regardless of how the conversation reads:\n${met.join("\n")}`);
  }
  if (open.length) {
    parts.push(
      `Still open per that same independent check — keep asking for these until they're answered, and never say or imply the case is ready while any of them remain:\n${open.join("\n")}`,
    );
  }
  return parts.join("\n\n");
}

export function buildIntakePrompt(input: {
  /** `caseAreas` are the case areas' names. */
  caseDetails: { title: string; caseAreas: string[]; ukJurisdiction: string | null; outsideUk?: boolean; where: string | null; side: string | null; notes: string | null };
  parties: { name: string; designation: string }[];
  messages: IntakeMessageInput[];
  documents: IntakeDocumentInput[];
  documentExcerpts: string;
  today: string;
  /** Set while the case still has its story placeholders (hasStoryPlaceholderDetails): the site's
   * case areas to suggest from, which also asks for a suggested title. */
  suggestFrom?: { code: string; name: string }[];
}): string {
  const msgs = input.messages.slice(-MAX_MESSAGES);
  const msgHandles = messageHandles(msgs);
  // The client's first message is where they told what happened (a whole story, on the story-first
  // way in), so it's given in full; later ones are cut.
  const firstId = msgs.find((m) => m.role === "user")?.id;
  const chatLines = [...msgHandles]
    .map(([handle, m]) => `${handle} (${ukDay(m.at)}, ${m.role === "user" ? "client" : "AI"}): ${m.text.slice(0, m.id === firstId ? CLIENT_STORY_MAX_LENGTH : MAX_MESSAGE_CHARS)}`)
    .join("\n\n");
  const suggest = input.suggestFrom?.length ? input.suggestFrom : null;
  const suggestInstructions = suggest
    ? `
- suggestedTitle: a short, neutral title for this case in the client's own language, at most ${SUGGESTED_TITLE_MAX} characters, saying what the problem is (e.g. "Dismissed without notice and owed wages"). No names of people, no legal conclusions.
- suggestedAreas: the code(s) from this list that best fit the problem, at most ${SUGGESTED_AREAS_MAX}, or [] if the conversation doesn't make it clear. Use only these codes:
${suggest.map((a) => `  ${a.code}: ${a.name}`).join("\n")}
suggestedTitle and suggestedAreas need no sources.`
    : "";
  const suggestJson = suggest ? `, "suggestedTitle": "", "suggestedAreas": ["CODE"]` : "";
  // Handles follow the input order, so each one's note is the input's at the same place.
  const docList =
    docsForPrompt(input.documents)
      .map((d, i) => `${d.id}: ${d.name}${input.documents[i]?.note ? ` (the client's note: ${input.documents[i]!.note})` : ""}`)
      .join("\n") || "(none uploaded yet)";

  return `You are organising a client's intake conversation for a UK solicitor who has not read it yet. You are not giving legal advice and must not propose a legal strategy, predict an outcome, or recommend a course of action.

Today's date is ${input.today}.

${caseDetailsBlock(input.caseDetails, input.parties)}

Documents on this case (cite by their handle, e.g. D1):
${docList}

Conversation (cite by its handle, e.g. M1):
${chatLines || "(no conversation yet)"}

From the conversation and the documents only — never invent or infer anything not stated — extract:
- people: every actual name you see anywhere above — in the conversation or in a document excerpt — of a person, company or organisation, whoever they are: the client themselves if a document uses their name, the other side, a witness, an insurer, a solicitor on a letter, anyone. This list drives redaction before a lawyer sees any of this, so completeness matters more than relevance — include a name even if their role is unclear or they otherwise wouldn't be worth mentioning. Give each their name exactly as written, their role if known (or "unclear" if not), and the message or document handle(s) it came from. If this person saw or can speak to what happened but is not themselves bringing or defending the claim, their role MUST contain the word "witness" (e.g. "witness", "witness — coworker who was present", "witness to the dismissal") — that exact word, not just the idea of it, is what tells the intake form to list them as a witness rather than a party, so never describe one only as "coworker", "bystander", or "passerby" without it.
- timeline: dated events, each with a date (YYYY-MM-DD if a full date is given, or null if not), datePrecision ("DAY"/"MONTH"/"YEAR"/"UNKNOWN"), and its source handle(s). Never work out a date yourself — only use one that is actually stated or computable from a stated relative date ("last Tuesday") against today's date.
- facts: other important factual statements, each with its source handle(s).
- goals: what the client said they want to happen.
- concerns: what the client said they are worried about.
- questionsForLawyer: anything the client explicitly asked to have a lawyer answer, or clearly wants a lawyer's view on, including anything that would be legal advice.
- deadlines: a hearing, deadline or time limit, ONLY when a specific date or clearly stated time is actually given — never computed from a legal rule. Include the date if given (YYYY-MM-DD), else null, and say what was said.
- relationship: the nature of the relationship between the client and the other side that this claim arises from (e.g. "employee of Acme Logistics since 2021", "tenant of 12 Mill Street", "customer under a 2024 service contract") — only when actually stated, never guessed from the type of case alone.
- roleAndTerms: the client's role or position and the financial or contractual terms involved (a job title and salary; a tenancy's rent and length; a contract's value and what was to be delivered) — only when actually stated.
- reasonGiven: the reason the OTHER side gave for the action being disputed (why they say they dismissed, evicted, refused, terminated, etc.) — the reason as stated, never a reason you infer must be true.
- missing: open questions a solicitor would need answered that nothing above covers yet (no sources needed). When the client was asked something and said they don't know or aren't sure, never guess the answer: list it here as a question for the lawyer to ask them.
- conflicts: places where two or more sources disagree on a fact, date, or detail — each needs at least two source handles, one from each side of the disagreement.
- storySoFar: up to ${STORY_SO_FAR_MAX} short lines that tell the client back the most important things they told us, so they can check we understood. Write each line to the client ("You…", "Your manager…"), in the same language the client wrote in, in plain everyday words with no legal terms. Put the one key detail of each line — a date, an amount, or the key fact — between ** and ** (e.g. "Your manager let you go on **3 March 2026**, effective immediately."), and use no other formatting. Each line has a kind: "DEADLINE" for a date by which something must be done that the client or a document actually stated, "FACT" for anything else. Never add advice, a legal view, or anything the client didn't say.${suggestInstructions}

Every item except "missing" must cite at least one real handle (Mn for the conversation, Dn p.N for a document, with the page if you can tell which page). Never cite a handle that doesn't exist. Do not repeat the known case details above as if you'd found them in the conversation.

${input.documentExcerpts}

The "summary" must be consistent with every other field you produce here, not written as if the documents list or excerpts above didn't exist. If a document is listed above, the summary must not say no documents were provided — say what they show instead, or that they're still being read if excerpts aren't available yet. If "timeline"/"facts" below cite a document for something, the summary citing or contradicting that same fact must agree with it.

Reply with only this JSON and nothing else, omitting a list entirely (as []) when there's nothing to put in it:
{"summary": "80-150 words, plain English, neutral, third person, no legal conclusions", "people": [{"name": "", "role": "", "sources": ["M1"]}], "timeline": [{"text": "", "date": null, "datePrecision": "UNKNOWN", "sources": ["M2"]}], "facts": [{"text": "", "sources": ["M1"]}], "goals": [{"text": "", "sources": ["M1"]}], "concerns": [{"text": "", "sources": ["M1"]}], "questionsForLawyer": [{"text": "", "sources": ["M1"]}], "deadlines": [{"text": "", "date": null, "sources": ["M1"]}], "relationship": [{"text": "", "sources": ["M1"]}], "roleAndTerms": [{"text": "", "sources": ["M1"]}], "reasonGiven": [{"text": "", "sources": ["M1"]}], "missing": [{"question": "", "why": ""}], "conflicts": [{"description": "", "sources": ["M1", "D1 p.2"]}], "storySoFar": [{"kind": "FACT", "text": "", "sources": ["M1"]}]${suggestJson}}`;
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
  relationship: IntakeItem[];
  roleAndTerms: IntakeItem[];
  reasonGiven: IntakeItem[];
  missing: CaseIntake["missing"];
  conflicts: CaseIntake["conflicts"];
  storySoFar: IntakeStoryLine[];
  /** Only when the prompt asked for it (buildIntakePrompt's suggestFrom); null otherwise. */
  suggestedTitle: string | null;
  /** Codes from `areaCodes` only; [] when none was given or the prompt didn't ask. */
  suggestedAreas: string[];
}

/** A story line as the screen shows it: one line, no list marker, and `**` only in pairs (an
 * unpaired one would leave the app showing stray asterisks, so all of them go). Null when there's
 * nothing left or it's too long to be a line. */
function storyLineText(raw: unknown): string | null {
  let text = str(raw).replace(/\s+/g, " ").replace(/^(?:[-*•]|\d+[.)])\s+/, "").trim();
  if ((text.match(/\*\*/g) ?? []).length % 2 !== 0) text = text.replace(/\*\*/g, "");
  if (!text.replace(/\*\*/g, "").trim() || text.length > STORY_LINE_MAX_CHARS) return null;
  return text;
}

/** A suggested title: one line, no quotes around it, no full stop, cut at a word. */
function suggestedTitleText(raw: unknown): string | null {
  const text = str(raw)
    .replace(/\s+/g, " ")
    .replace(/^["'“‘]+|["'”’]+$/g, "")
    .replace(/[.。]$/, "")
    .trim();
  return text ? cutAtWord(text, SUGGESTED_TITLE_MAX) : null;
}

/** Parses the AI's JSON reply. Returns null when there's nothing usable at all (no summary and no
 * extracted lists) — the caller then keeps whatever was there before. Every source is resolved
 * against the real documents/messages this run was built from; a handle that matches none is
 * dropped. An item left with no sources is dropped too, except `missing` (never sourced) and the
 * top-level `summary`. A conflict needs at least two surviving sources, or it's dropped: a single
 * source can't itself be a disagreement. A story line needs a source like any other item.
 * `areaCodes` are the site's case-area codes a suggestedAreas entry must be one of. */
export function parseIntakeReply(reply: string, docs: CaseDoc[], messages: IntakeMessageInput[], areaCodes: string[] = []): ParsedIntake | null {
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
  const relationship = simpleList("relationship", "relationship");
  const roleAndTerms = simpleList("roleAndTerms", "roleAndTerms");
  const reasonGiven = simpleList("reasonGiven", "reasonGiven");

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

  const storyAll = arr(parsed.storySoFar)
    .map((raw): IntakeStoryLine | null => {
      const text = storyLineText(raw.text);
      if (!text) return null;
      const sources = parseSources(raw, docs, messages);
      if (!sources.length) return null;
      const kind = raw.kind === "DEADLINE" ? "DEADLINE" : "FACT";
      return { id: stableId(`story-${kind}`, text), kind, text, sources };
    })
    .filter((x): x is IntakeStoryLine => x !== null);
  // Facts first, deadlines last, each in the order the AI gave them; then the screen's limit.
  const storySoFar = [...dedupe(storyAll.filter((l) => l.kind === "FACT")), ...dedupe(storyAll.filter((l) => l.kind === "DEADLINE"))].slice(0, STORY_SO_FAR_MAX);

  const suggestedTitle = suggestedTitleText(parsed.suggestedTitle);
  const known = new Set(areaCodes);
  const suggestedAreas = [...new Set((Array.isArray(parsed.suggestedAreas) ? parsed.suggestedAreas : []).map(str).filter((c) => known.has(c)))].slice(0, SUGGESTED_AREAS_MAX);

  const nothingUsable =
    !summary &&
    ![people, timeline, facts, goals, concerns, questionsForLawyer, deadlines, relationship, roleAndTerms, reasonGiven, missing, conflicts, storySoFar].some((l) => l.length);
  if (nothingUsable) return null;

  return {
    summary,
    people,
    timeline,
    facts,
    goals,
    concerns,
    questionsForLawyer,
    deadlines,
    relationship,
    roleAndTerms,
    reasonGiven,
    missing,
    conflicts,
    storySoFar,
    suggestedTitle,
    suggestedAreas,
  };
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
