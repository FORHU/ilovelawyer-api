import crypto from "crypto";
import type { ClientRequestStatus, Prisma } from "@prisma/client";
import ClientRequestRepo from "../repositories/client-request.repository";
import ClientRequestNotifySvc from "./client-request-notify.service";
import ChatRepo from "../repositories/chat.repository";
import { callChatWonderRest, getChatWonderSessionId } from "../utils/chatWonder";
import { labelForDesignation, redactBrief, type RedactionContext } from "../utils/brief-redaction";
import { REQUEST_URGENCIES, type RequestUrgency } from "../types/client-handoff";
import logger from "../utils/logger";

/** CaseBrief in the contract: what every matching lawyer sees before claiming. */
export interface CaseBrief {
  summary: string;
  practiceArea: string | null;
  ukJurisdiction: string | null;
  urgency: RequestUrgency;
  knownDeadline: string | null;
  clientNote: string;
  generatedAt: string;
}

/** Once a lawyer holds the request they've seen the names anyway, and the brief stops changing. */
const BRIEF_REFRESH_STATUSES: ClientRequestStatus[] = ["REQUESTED", "ROUTED"];

const MAX_MESSAGES = 30;
const MAX_MESSAGE_CHARS = 2000;

const DAY_MS = 24 * 60 * 60 * 1000;
/** A deadline outside these is a misreading (the wrong year, #597), not a real one: dropped. */
const DEADLINE_MAX_PAST_DAYS = 365;
const DEADLINE_MAX_AHEAD_DAYS = 730;

/** A day as the client sees it, YYYY-MM-DD: UK time, so a message sent at 00:30 BST is that day. */
export function ukDay(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** Days from today (UK) to `day` (YYYY-MM-DD): negative once it has passed. */
function daysUntil(day: string, now: Date): number {
  return Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${ukDay(now)}T00:00:00Z`)) / DAY_MS);
}

/**
 * The urgency, from how many days away the nearest deadline is when that's known, as the prompt
 * defines it: URGENT within 7 days or past, SOON within 30. Further off, SOON can't be right, so
 * it's ROUTINE; URGENT stays, as the AI may know of something sooner (a hearing tomorrow). With no
 * deadline at all, the AI's own rating.
 */
export function urgencyFor(rated: RequestUrgency, days: number | null): RequestUrgency {
  if (days === null) return rated;
  if (days <= 7) return "URGENT";
  if (days <= 30) return rated === "URGENT" ? "URGENT" : "SOON";
  return rated === "URGENT" ? "URGENT" : "ROUTINE";
}

/** The AI's rough count of days to the nearest deadline: a whole number in the plausible range, or null. */
function plausibleDays(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const days = Math.round(value);
  return days < -DEADLINE_MAX_PAST_DAYS || days > DEADLINE_MAX_AHEAD_DAYS ? null : days;
}

/** A real calendar date, close enough to now to be one the client gave; otherwise null. */
function plausibleDeadline(value: unknown, now: Date): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const at = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== value) return null;
  const days = daysUntil(value, now);
  return days < -DEADLINE_MAX_PAST_DAYS || days > DEADLINE_MAX_AHEAD_DAYS ? null : value;
}

type BriefSource = NonNullable<Awaited<ReturnType<typeof ClientRequestRepo.findForBrief>>>;

/** What the brief is written from, without the parts that only change bookkeeping (Case.updatedAt
 * moves on every credit spent), so an unchanged case is never re-written. */
export function briefFingerprint(source: BriefSource, latestMessageId: string | null): string {
  const c = source.case;
  const basis = JSON.stringify([
    c.caseName,
    c.practiceArea,
    c.ukJurisdiction,
    c.jurisdiction,
    c.clientSide,
    c.parties.map((p) => [p.name, p.designation]),
    c.documents.map((d) => d.id),
    latestMessageId,
    source.note,
  ]);
  return crypto.createHash("sha256").update(basis).digest("hex");
}

function redactionContext(source: BriefSource): RedactionContext {
  const people = source.case.parties.map((p) => ({ name: p.name, label: labelForDesignation(p.designation) }));
  for (const name of [source.client.name, source.client.username]) {
    if (name?.trim()) people.push({ name: name.trim(), label: "the client" });
  }
  return { people, documentNames: source.case.documents.map((d) => d.name) };
}

interface ConversationMessage {
  from: string;
  text: string;
  at: Date;
}

/** The AI is told today's date and when each message was sent, so it can place "on Tuesday" or "in
 * two months" in time and judge "within 7 days" (#597): without them it guessed the year. */
function buildPrompt(source: BriefSource, conversation: ConversationMessage[], now: Date): string {
  const c = source.case;
  const details = [
    `Case title: ${c.caseName}`,
    `Type of problem: ${c.practiceArea ?? "not set"}`,
    `Part of the UK: ${c.ukJurisdiction ?? "not set"}`,
    `Town or city: ${c.jurisdiction ?? "not set"}`,
    `The client is: ${c.clientSide === "CLAIMANT" ? "bringing the complaint" : c.clientSide === "RESPONDENT" ? "responding to one" : "not set"}`,
    `Others involved: ${c.parties.map((p) => `${p.designation}`).join(", ") || "none listed"}`,
    `The client's note to the lawyer: ${source.note || "none"}`,
  ].join("\n");
  const chat = conversation.map((m) => `${m.from === "user" ? "Client" : "AI"} (${ukDay(m.at)}): ${m.text}`).join("\n\n");
  const today = ukDay(now);
  return `You are preparing an anonymised case summary for UK solicitors deciding whether to take on a new client.

Today's date is ${today}. Each message below shows the date it was sent. Work out any relative dates ("on Tuesday", "in two months") from those dates.

Write for a solicitor, in plain English, 80 to 180 words: what happened and when, where things stand now, what the client wants, and anything time-sensitive. Refer to people only by their role (the client, the employer, the landlord, the seller), never by name. Do not mention document names, addresses, email addresses or phone numbers. Do not give legal advice. Use only the case details and the conversation below.

Then rate the urgency, counting from today: URGENT if a hearing, deadline or time limit is within 7 days or has passed, SOON if within 30 days, otherwise ROUTINE. Rate a rough time the same way: "in about two months" is ROUTINE, "in a couple of weeks" is SOON.

knownDeadline: only when the client gives a specific calendar date for a deadline, hearing or time limit, that date as YYYY-MM-DD. If they only give a rough time ("in about two months") or none, use null, and say what they said in the summary. Never work out a date yourself.

daysUntilDeadline: roughly how many days from today until the nearest deadline, hearing or time limit the client mentions, exact or rough ("in about two months" is about 60), as a whole number, negative if it has passed. null if they mention none.

Reply with only this JSON and nothing else:
{"summary": "...", "urgency": "ROUTINE", "knownDeadline": null, "daysUntilDeadline": null}

Case details:
${details}

Conversation between the client and the AI:
${chat || "(no conversation yet)"}`;
}

/** The AI's reply as { summary, urgency, knownDeadline }, or null when it isn't usable. A deadline
 * that isn't a real date, or is implausibly far from `now`, is dropped. The urgency follows the
 * deadline (urgencyFor) rather than the AI's own label: the date when the client gave one, else the
 * AI's rough count of days (daysUntilDeadline, never shown). */
export function parseBriefReply(reply: string, now: Date = new Date()): { summary: string; urgency: RequestUrgency; knownDeadline: string | null } | null {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: { summary?: unknown; urgency?: unknown; knownDeadline?: unknown; daysUntilDeadline?: unknown };
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  if (!summary) return null;
  const rated = (REQUEST_URGENCIES as readonly unknown[]).includes(parsed.urgency) ? (parsed.urgency as RequestUrgency) : "ROUTINE";
  const deadline = plausibleDeadline(parsed.knownDeadline, now);
  const days = deadline ? daysUntil(deadline, now) : plausibleDays(parsed.daysUntilDeadline);
  return { summary, urgency: urgencyFor(rated, days), knownDeadline: deadline };
}

/**
 * The anonymised brief for a client request (#508): an AI summary of the case and its chat, the
 * practice area, the part of the UK and the urgency, with no names and no documents. Written when
 * the request is made, and again if the case changes before a lawyer claims it. Whatever the AI
 * writes goes through redactBrief before it's stored, so nothing identifying reaches a lawyer even
 * if the AI slips.
 */
export default class ClientRequestBriefSvc {
  /** Writes (or rewrites) the brief. Never throws: a failure is stored as briefError and the next
   * read tries again. */
  static async generate(requestId: string): Promise<CaseBrief | null> {
    const source = await ClientRequestRepo.findForBrief(requestId);
    if (!source) return null;
    try {
      const { conversation, latestMessageId } = await ClientRequestBriefSvc.conversationOf(source);
      const session = await getChatWonderSessionId();
      const now = new Date();
      const reply = await callChatWonderRest(buildPrompt(source, conversation, now), session, undefined, "UK", {
        usage: { feature: "clientRequestBrief", userId: source.clientId, caseId: source.caseId },
      });
      const parsed = parseBriefReply(String(reply.response ?? reply.intermediate_response ?? ""), now);
      if (!parsed) throw new Error("The AI's reply had no usable summary");

      const ctx = redactionContext(source);
      const brief: CaseBrief = {
        summary: redactBrief(parsed.summary, ctx),
        practiceArea: source.case.practiceArea,
        ukJurisdiction: source.case.ukJurisdiction,
        urgency: parsed.urgency,
        knownDeadline: parsed.knownDeadline,
        clientNote: redactBrief(source.note, ctx),
        generatedAt: new Date().toISOString(),
      };
      await ClientRequestRepo.saveBrief(requestId, {
        brief: brief as unknown as Prisma.InputJsonValue,
        briefFingerprint: briefFingerprint(source, latestMessageId),
        briefGeneratedAt: new Date(brief.generatedAt),
      });
      // Lawyers are told once there's a brief to read (#510). Only the first time: announcing is
      // guarded, so a rewrite of an announced request tells nobody again.
      ClientRequestNotifySvc.announceInBackground(requestId);
      return brief;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("Client request brief: generation failed", { requestId, err: message });
      await ClientRequestRepo.saveBrief(requestId, { briefError: message.slice(0, 500) });
      return null;
    }
  }

  /** The brief as a lawyer should see it now: rewritten first if the case changed (or the last try
   * failed) and no lawyer has claimed the request yet. For the lawyer-facing reads (#509, #511). */
  static async current(requestId: string): Promise<CaseBrief | null> {
    const source = await ClientRequestRepo.findForBrief(requestId);
    if (!source) return null;
    const stored = source.brief as unknown as CaseBrief | null;
    if (!BRIEF_REFRESH_STATUSES.includes(source.status)) return stored;
    const { latestMessageId } = await ClientRequestBriefSvc.conversationOf(source);
    if (stored && source.briefFingerprint === briefFingerprint(source, latestMessageId)) return stored;
    return (await ClientRequestBriefSvc.generate(requestId)) ?? stored;
  }

  /** Starts writing the brief without holding up the request (POST /client/lawyer-requests). */
  static generateInBackground(requestId: string): void {
    ClientRequestBriefSvc.generate(requestId).catch((err) => logger.error("Client request brief: background run failed", { requestId, err }));
  }

  private static async conversationOf(source: BriefSource) {
    const consultationId = source.case.consultations[0]?.id;
    if (!consultationId) return { conversation: [], latestMessageId: null };
    const messages = (await ChatRepo.listMessagesByConsultation(consultationId)).filter((m) => m.role === "user" || m.role === "assistant");
    return {
      conversation: messages.slice(-MAX_MESSAGES).map((m): ConversationMessage => ({ from: m.role, text: m.content.slice(0, MAX_MESSAGE_CHARS), at: m.createdAt })),
      latestMessageId: messages.at(-1)?.id ?? null,
    };
  }
}
