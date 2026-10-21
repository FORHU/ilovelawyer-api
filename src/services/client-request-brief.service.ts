import crypto from "crypto";
import type { ClientRequestStatus, Prisma } from "@prisma/client";
import ClientRequestRepo from "../repositories/client-request.repository";
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

function buildPrompt(source: BriefSource, conversation: { from: string; text: string }[]): string {
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
  const chat = conversation.map((m) => `${m.from === "user" ? "Client" : "AI"}: ${m.text}`).join("\n\n");
  return `You are preparing an anonymised case summary for UK solicitors deciding whether to take on a new client.

Write for a solicitor, in plain English, 80 to 180 words: what happened and when, where things stand now, what the client wants, and anything time-sensitive. Refer to people only by their role (the client, the employer, the landlord, the seller), never by name. Do not mention document names, addresses, email addresses or phone numbers. Do not give legal advice. Use only the case details and the conversation below.

Then rate the urgency: URGENT if a hearing, deadline or time limit is within 7 days or has passed, SOON if within 30 days, otherwise ROUTINE. If the conversation states a specific deadline date, give it as YYYY-MM-DD, otherwise null.

Reply with only this JSON and nothing else:
{"summary": "...", "urgency": "ROUTINE", "knownDeadline": null}

Case details:
${details}

Conversation between the client and the AI:
${chat || "(no conversation yet)"}`;
}

/** The AI's reply as { summary, urgency, knownDeadline }, or null when it isn't usable. */
export function parseBriefReply(reply: string): { summary: string; urgency: RequestUrgency; knownDeadline: string | null } | null {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: { summary?: unknown; urgency?: unknown; knownDeadline?: unknown };
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  if (!summary) return null;
  const urgency = (REQUEST_URGENCIES as readonly unknown[]).includes(parsed.urgency) ? (parsed.urgency as RequestUrgency) : "ROUTINE";
  const deadline = typeof parsed.knownDeadline === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.knownDeadline) ? parsed.knownDeadline : null;
  return { summary, urgency, knownDeadline: deadline };
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
      const reply = await callChatWonderRest(buildPrompt(source, conversation), session, undefined, "UK", {
        usage: { feature: "clientRequestBrief", userId: source.clientId, caseId: source.caseId },
      });
      const parsed = parseBriefReply(String(reply.response ?? reply.intermediate_response ?? ""));
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
      conversation: messages.slice(-MAX_MESSAGES).map((m) => ({ from: m.role, text: m.content.slice(0, MAX_MESSAGE_CHARS) })),
      latestMessageId: messages.at(-1)?.id ?? null,
    };
  }
}
