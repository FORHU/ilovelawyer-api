import { choice, noul } from "@typesafe-ai/sdk";
import { getTypeSafeClient } from "./typesafeClient";
import logger from "./logger";

/** Pilot flag — see benchmarks/jev-report-2026-09-21.md. Unset/false: no triage call at all.
 *
 * Read per call rather than captured at module load: the captured form made the flag's value
 * depend on whether something else had already run dotenv.config() before this module was first
 * imported, so adding an unrelated import could silently switch triage on. */
function triageEnabled(): boolean {
  return process.env.USE_JEV_MESSAGE_TRIAGE === "true";
}

/** Jev's `noul` score at or above which a message counts as urgent. Benchmarked routine messages
 * topped out at 0.13 and explicitly urgent ones bottomed at 0.95; implicit (date-only) urgency
 * lands at 0.54–0.90, so this stays at the midpoint rather than creeping up. */
export const URGENCY_THRESHOLD = 0.5;

/** Stricter bar for anything user-facing beyond the chat itself (notifications to other
 * participants). A false "urgent" badge in the list is cheap; a false push to a partner isn't. */
export const URGENCY_NOTIFY_THRESHOLD = 0.85;

/** Intent confidence at or above which the intent hint is injected into chat-wonder's context.
 * Below it the intent is still persisted (for the list, analytics, backtests) but the model is
 * left to read the message on its own — a wrong steer is worse than none. */
export const INTENT_HINT_THRESHOLD = 0.7;

/** `refersToAttachment` score at or above which the message is treated as depending on a document
 * the user thinks they've supplied. Only acted on when nothing is actually attached or grounded —
 * then chat-wonder is told to say so instead of improvising the document's contents (the #1
 * grading deduction on the Brackenmoor benchmark: asserting material is absent, or answering
 * about material never seen). */
export const ATTACHMENT_THRESHOLD = 0.75;

/**
 * What the user is asking the assistant to DO — one label per message, aligned with the legal
 * persona's actual capabilities in chat-wonder (get_legal_recommendation, analyze_document,
 * generate_legal_document, draft_pleading, the research tools) plus the paralegal-style work the
 * product does around them. A const tuple rather than a Prisma enum (see ai-generation-kinds.ts)
 * so a new intent never needs a migration.
 */
export const MESSAGE_INTENTS = [
  "CONSULTATION",
  "DRAFT_DOCUMENT",
  "DRAFT_PLEADING",
  "ANALYZE_DOCUMENT",
  "LEGAL_RESEARCH",
  "PARALEGAL_TASK",
  "DEADLINE_COMPUTATION",
  "REVISE_PREVIOUS",
  "OTHER",
] as const;
export type MessageIntent = (typeof MESSAGE_INTENTS)[number];

/** How each intent reads in a notification title or a UI chip — "a pleading request", not
 * "DRAFT_PLEADING". */
export const INTENT_LABELS: Record<MessageIntent, string> = {
  CONSULTATION: "consultation",
  DRAFT_DOCUMENT: "document request",
  DRAFT_PLEADING: "pleading request",
  ANALYZE_DOCUMENT: "document review request",
  LEGAL_RESEARCH: "research question",
  PARALEGAL_TASK: "paralegal task",
  DEADLINE_COMPUTATION: "deadline question",
  REVISE_PREVIOUS: "revision request",
  OTHER: "message",
};

/** One-line definition per intent — used verbatim in the Jev question so the model and the
 * humans reading the persisted label mean the same thing by it. */
export const INTENT_DEFINITIONS: Record<MessageIntent, string> = {
  CONSULTATION: "asks for legal advice, an opinion, options, risks, or next steps on their own situation — including a message that just describes a legal situation or development (a hearing, an arrest, a deadline, a notice received) with the request for help left implied",
  DRAFT_DOCUMENT: "wants a finished legal instrument produced that will be signed, sent, or served — a contract, agreement, demand letter, notice, affidavit, legal memo to a client, or similar",
  DRAFT_PLEADING: "wants a court filing produced — a complaint, answer, motion, petition, brief, or other pleading",
  ANALYZE_DOCUMENT: "wants an attached, uploaded, pasted, or case document reviewed, summarised, checked, or explained",
  LEGAL_RESEARCH: "wants to know what the law is — authorities, statutes, cases, rules, or a general overview of a legal topic — rather than advice on their own facts",
  PARALEGAL_TASK: "wants administrative, organisational, or internal work product — a chronology, timeline, checklist, deadline calendar, case summary, exhibit list, citation formatting, transcript clean-up, or training, presentation, or newsletter material",
  DEADLINE_COMPUTATION: "asks WHEN something is due or how a period is counted — the last day to answer, appeal, file, or respond, computed from a date and a rule (e.g. 'served on the 8th, when is the answer due?')",
  REVISE_PREVIOUS: "asks to change, extend, shorten, translate, reformat, or fix the assistant's PREVIOUS answer or draft ('make it shorter', 'add a clause', 'redo that in Tagalog', 'use the other party's name') rather than starting something new",
  OTHER: "a greeting, test, thanks, small talk, or a message with no legal content at all — NOT a description of a legal situation, which is CONSULTATION",
};

export interface UrgencyFlag {
  urgent: boolean;
  probability: number;
}

export interface MessageTriage extends UrgencyFlag {
  intent: MessageIntent;
  intentConfidence: number;
  intentProbabilities: Partial<Record<MessageIntent, number>>;
  /** Probability that the message refers to a document/file/email the assistant would need to
   * read — compared against what is actually attached or grounded, see missingAttachmentContextFor. */
  refersToAttachment: number;
}

export function isMessageIntent(value: unknown): value is MessageIntent {
  return typeof value === "string" && (MESSAGE_INTENTS as readonly string[]).includes(value);
}

/** The intent question exactly as Jev sees it: one line per label, in MESSAGE_INTENTS order, with
 * its definition. Built from the tables so a label can't exist without a definition (the type
 * enforces it) and a definition can't be silently left out of the prompt. */
export function intentQuestion(): string {
  return (
    "What is the user asking the legal assistant to do? Pick the single best label:\n" +
    MESSAGE_INTENTS.map((k) => `${k} — ${INTENT_DEFINITIONS[k]}`).join("\n")
  );
}

/** The raw shape of Jev's three answers — kept structural (not the SDK's types) so parseTriage
 * can be unit-tested with plain objects. */
export interface RawTriageAnswers {
  urgency: { noul: number };
  intent: { choice: string; confidence: number; probabilities: Record<string, number> };
  attachment: { noul: number };
}

/** Turns Jev's answers into a MessageTriage: applies URGENCY_THRESHOLD, maps an unknown or
 * malformed intent label to OTHER (never throws on a label the SDK version might add), and keeps
 * only known intents in the probability map. Pure — the network call is triageMessage. */
export function parseTriage(answers: RawTriageAnswers): MessageTriage {
  const intent: MessageIntent = isMessageIntent(answers.intent.choice) ? answers.intent.choice : "OTHER";
  const intentProbabilities: Partial<Record<MessageIntent, number>> = {};
  for (const [k, v] of Object.entries(answers.intent.probabilities ?? {})) {
    if (isMessageIntent(k) && typeof v === "number") intentProbabilities[k] = v;
  }
  return {
    urgent: answers.urgency.noul >= URGENCY_THRESHOLD,
    probability: answers.urgency.noul,
    intent,
    intentConfidence: answers.intent.confidence,
    intentProbabilities,
    refersToAttachment: answers.attachment.noul,
  };
}

/**
 * Classifies one incoming consultation/case chat message for urgency AND intent in a single Jev
 * call. The result is persisted on the user Message row (urgent, urgencyProbability, intent,
 * intentConfidence), mirrored to Consultation.urgentAt, pushed over the socket and (above
 * URGENCY_NOTIFY_THRESHOLD) raised as a notification — see ChatSvc.processChatGenerationJob.
 * Never throws: a failed/unavailable call just skips triage, same as every other best-effort
 * AI-derived signal in this codebase.
 */
export async function triageMessage(userInput: string): Promise<MessageTriage | null> {
  if (!triageEnabled()) return null;
  const message = userInput?.trim();
  if (!message) return null;

  try {
    const client = getTypeSafeClient();
    logger.info("Jev request", { feature: "message-triage", questions: ["urgency", "intent", "attachment"], content: message });
    const intentOptions = Object.fromEntries(MESSAGE_INTENTS.map((k) => [k, null])) as Record<MessageIntent, null>;
    const response = await client.systemOne({
      state: { message },
      questions: {
        urgency: noul(
          "Does this message need prompt action from the lawyer receiving it? Yes if there is a deadline, limitation period, hearing, or emergency that binds the user or their client and is live and approaching — including one the reader must infer from a date plus a known rule. No if the only period mentioned is one the user is GIVING to someone else, if the event is routine and weeks or months away, if the matter is already concluded, if a date appears only inside a citation or reference, or if the message asks in general terms how a rule or period works.",
        ),
        intent: choice(intentQuestion(), intentOptions),
        attachment: noul(
          "Does the message refer to a specific document, file, email, contract, decision, or other material that the user has attached or uploaded, or expects the assistant to already have on file — such that the assistant would need to read that material to answer? Material quoted or pasted inside the message itself does NOT count, and neither does the assistant's own previous answer or draft.",
        ),
      },
    });
    const result = parseTriage(response.answers as unknown as RawTriageAnswers);
    logger.info("Jev response", {
      feature: "message-triage",
      urgent: result.urgent,
      probability: result.probability,
      intent: result.intent,
      intentConfidence: result.intentConfidence,
      intentProbabilities: result.intentProbabilities,
      refersToAttachment: result.refersToAttachment,
    });
    return result;
  } catch (err) {
    logger.warn("Jev error", { feature: "message-triage", err });
    return null;
  }
}

/** Urgency-only view of triageMessage — kept for the benchmark scripts and any caller that only
 * cares about the flag. Same single Jev call underneath; no extra cost. */
export async function flagMessageUrgency(userInput: string): Promise<UrgencyFlag | null> {
  const triage = await triageMessage(userInput);
  return triage ? { urgent: triage.urgent, probability: triage.probability } : null;
}

/**
 * The system-prompt note chat-wonder receives for an urgent turn, via the `document_context`
 * field (it lands under chat-wonder's "[CASE CONTEXT — background …]" label, so it has to read
 * as an instruction to have any effect — a soft "prioritize directness" nudge benchmarked as a
 * tone change only, see jev-report-2026-09-21.md §4–5). Tells the model what to do differently
 * rather than restating the urgency it can already see. Empty string for a routine/untriaged
 * turn so callers can `.filter(Boolean)` it straight into resolvedContext.
 */
export function urgencyContextFor(flag: UrgencyFlag | null): string {
  if (!flag?.urgent) return "";
  const pct = Math.round(flag.probability * 100);
  return [
    `[URGENT — triage flagged this message as time-critical (${pct}% confidence).]`,
    `Structure the answer for a lawyer who must act today:`,
    `1. Open with the single most important action and its deadline, in one or two sentences.`,
    `2. Follow with a numbered, dated checklist of what to file or do, in order, before any background discussion.`,
    `3. State explicitly what happens if the deadline is missed, and any last-resort remedy.`,
    `4. Keep it under 600 words; leave out general background that does not change today's actions.`,
  ].join("\n");
}

/** Per-intent steer for chat-wonder. Only the intents where the model demonstrably needs a push
 * get one: the document intents (it sometimes describes what a document would say instead of
 * calling generate_legal_document/draft_pleading), analysis (so it reads the attached material
 * before answering), and paralegal work (so it produces the artefact, not advice about it).
 * CONSULTATION and LEGAL_RESEARCH are the persona's defaults and need no hint; OTHER gets none. */
export const INTENT_HINTS: Partial<Record<MessageIntent, string>> = {
  DRAFT_DOCUMENT:
    "The user wants a finished document, not a description of one. Produce the complete document text (or use the document-generation tool if available) with every clause drafted; put any assumptions or blanks in [brackets] at the end.",
  DRAFT_PLEADING:
    "The user wants a court filing, not advice about one. Draft the pleading in the proper form for the forum — caption, title, numbered allegations or grounds, prayer/relief, signature block, verification where required (or use the pleading-drafting tool if available). Put assumptions in [brackets] at the end.",
  ANALYZE_DOCUMENT:
    "The user is asking about a specific document. Ground every point in that document's actual text — quote or cite the clause, page, or paragraph — and say explicitly if the document or a part of it is not available to you rather than answering from general knowledge.",
  PARALEGAL_TASK:
    "The user wants a work product (chronology, checklist, calendar, summary, list), not advice. Produce it directly in a structured, complete form — a table or numbered list — drawn from the case material, and keep commentary to a short note at the end.",
  DEADLINE_COMPUTATION:
    "The user is asking for a date. Show the computation, not just the answer: (1) the triggering event and its date, (2) the governing rule and the period it sets, citing the rule, (3) how the period is counted — calendar or working days, whether the first day is excluded, what happens if the last day falls on a weekend or holiday, (4) the resulting date. If any input is missing or the rule has changed recently, say so and give the date under each alternative rather than picking one silently.",
  REVISE_PREVIOUS:
    "The user is asking to change the previous answer or draft, not for something new. Apply exactly the change requested to the earlier text and return the complete revised version, keeping everything else as it was. If the earlier text is not in this conversation's history, say so and ask the user to paste it.",
};

/** The intent hint for chat-wonder, or "" when there is nothing useful to say (untriaged,
 * OTHER/CONSULTATION/LEGAL_RESEARCH, or confidence below INTENT_HINT_THRESHOLD). */
export function intentContextFor(triage: MessageTriage | null): string {
  if (!triage) return "";
  const hint = INTENT_HINTS[triage.intent];
  if (!hint || triage.intentConfidence < INTENT_HINT_THRESHOLD) return "";
  const pct = Math.round(triage.intentConfidence * 100);
  return `[REQUEST TYPE: ${triage.intent} (${pct}% confidence).]\n${hint}`;
}

/**
 * The guard for a message that talks about a document the assistant doesn't have. Fires only when
 * Jev is confident the message depends on attached material AND the worker found nothing attached
 * to the message, nothing grounded from the consultation/case, and no pasted document_context.
 * Without it chat-wonder either improvises the document's contents or asserts it "isn't in the
 * bundle" — both graded as grounding failures on Brackenmoor. "" when it doesn't apply.
 */
export function missingAttachmentContextFor(triage: MessageTriage | null, hasAttachedMaterial: boolean): string {
  if (!triage || hasAttachedMaterial || triage.refersToAttachment < ATTACHMENT_THRESHOLD) return "";
  // "Redo the demand letter in Tagalog" refers to the assistant's own previous draft, which lives
  // in the conversation history, not in an attachment — the guard must never fire on a revision.
  if (triage.intent === "REVISE_PREVIOUS") return "";
  const pct = Math.round(triage.refersToAttachment * 100);
  return [
    `[NO DOCUMENT AVAILABLE — the message refers to a document, file, or email (${pct}% confidence) but nothing is attached to this message and nothing matching was found in the case.]`,
    `Do not guess or reconstruct the document's contents. Say plainly, in the first sentence, that the document is not available to you and ask the user to upload or paste it. Then answer only the parts of the question that do not depend on it.`,
  ].join("\n");
}

export interface TriageNotification {
  /** Notification title, built from the triage result — e.g. "Urgent pleading request (99%) in Santos v. Reyes". */
  title: string;
  /** Why this triage result is worth interrupting the other participants — logged and stored. */
  reason: "urgent";
}

/**
 * The one place that decides whether a triage result is worth interrupting the OTHER people on a
 * consultation (the sender already knows), and how to word it. Kept as a pure function so the
 * policy is testable and extendable without touching the delivery code in ChatSvc — a new rule
 * (say, a pleading request on a case with a hearing this week) is one more branch here.
 *
 * Current policy: urgency at or above URGENCY_NOTIFY_THRESHOLD, whatever the intent. The intent
 * still shapes the title so the recipient knows what kind of urgent thing it is. Returns null when
 * nobody should be pinged — a borderline flag badges the consultation list (Consultation.urgentAt)
 * without a push.
 */
export function notificationFor(triage: MessageTriage | null, consultationTitle: string | null): TriageNotification | null {
  if (!triage) return null;
  if (triage.urgent && triage.probability >= URGENCY_NOTIFY_THRESHOLD) {
    const what = INTENT_LABELS[triage.intent];
    const pct = Math.round(triage.probability * 100);
    return {
      title: `Urgent ${what} (${pct}%) in ${consultationTitle ?? "a consultation"}`,
      reason: "urgent",
    };
  }
  return null;
}

/** Everything triage contributes to resolvedContext for one turn — urgency block first (it
 * changes the shape of the whole answer), then the missing-attachment guard (it changes what the
 * answer may claim), then the intent steer. Blank lines between, "" when none applies. */
export function triageContextFor(triage: MessageTriage | null, opts: { hasAttachedMaterial?: boolean } = {}): string {
  return [
    urgencyContextFor(triage),
    missingAttachmentContextFor(triage, opts.hasAttachedMaterial ?? true),
    intentContextFor(triage),
  ]
    .filter(Boolean)
    .join("\n\n");
}
