import { choice } from "@typesafe-ai/sdk";
import { jevAsk } from "./typesafeClient";
import { applyFloor, optionsInOrder, readChoice } from "./jev-common";
import logger from "./logger";

/**
 * Jev deciding when a client's case has enough in it to suggest a lawyer (the client app). One
 * yes/no question per thing a solicitor needs before picking a case up, each with Jev's confidence,
 * so the client can see exactly what's known and what's missing, never just "not yet". Plus which
 * case areas the problem falls under, which lawyer matching uses: one yes/no per area (a problem
 * can fall under several), and one for personal injury, which is never matched.
 *
 * Off unless USE_JEV_LAWYER_READINESS=true; the client app then falls back to offering a lawyer
 * after any AI answer, as before.
 */
export function isLawyerReadinessJevEnabled(): boolean {
  return process.env.USE_JEV_LAWYER_READINESS === "true";
}

export const READINESS_CRITERIA = [
  {
    key: "problem",
    label: "What kind of problem it is",
    question:
      "Do `caseDetails` and `conversation` make clear what legal problem the client has, specifically enough to name it (for example an unfair dismissal, a deposit a landlord won't return, a faulty car), not just a broad category?",
  },
  {
    key: "place",
    label: "Where in the UK it happened",
    question:
      "Is it clear which part of the UK the problem is in: England and Wales, Scotland, or Northern Ireland? `caseDetails.ukJurisdiction` counts when it is set.",
  },
  {
    key: "otherSide",
    label: "Who the other side is",
    question:
      "Is it clear who the client's problem is with? A relationship or role used consistently through the conversation (their neighbour, their landlord, their employer, a named business) counts, even with no proper name given — don't require more precision than the client's own story already makes clear.",
  },
  {
    key: "events",
    label: "What happened, and roughly when",
    question:
      "Has the client described what happened and roughly when (a date, a month, or how long ago), clearly enough for a solicitor to follow the sequence of events?",
  },
  {
    key: "goal",
    label: "What you want to get out of it",
    question:
      "Has the client said what outcome they want? If the assistant's own question offered example outcomes (for example compensation, their job back, a refund, repairs, resolving the dispute, or defending a claim) and the client's answer picks or restates one of those, that counts as answered even in a single word — don't require more elaboration than what was actually offered and accepted.",
  },
  {
    key: "status",
    label: "What's happened since, and where things stand now",
    question:
      "Has the client said where things currently stand — any contact with the other side, a response received, action already taken (a letter, a complaint, an insurer notified) — or plainly that nothing has happened yet or they haven't heard back? Either answer counts, as long as the client was actually asked and actually said so; it does not count if this was never asked or never answered.",
  },
] as const;

export type ReadinessKey = (typeof READINESS_CRITERIA)[number]["key"];

/** Jev must be at least this sure a point is covered for it to count. Provisional: set it from a
 * benchmark of real client conversations before relying on it outside staging. */
export const READINESS_MIN_CONFIDENCE = 0.7;

/** A case area Jev can put the problem under (CaseAreaSvc.forJev): switched-on ones only. */
export interface ReadinessAreaOption {
  code: string;
  name: string;
  description: string;
}

/** The question key for one case area's yes/no. */
const areaKey = (code: string) => `area_${code}`;

const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 1500;

/** NO first: Jev leans toward the first option listed (jev-common.ts), and a missed suggestion
 * costs less than suggesting a lawyer too early. */
const ANSWERS = ["NO", "YES"] as const;

export interface ReadinessInput {
  caseDetails: {
    title: string;
    /** The case areas' names, as the client picked them. */
    areas: string[];
    ukJurisdiction: string | null;
    where: string | null;
    side: string | null;
    otherParties: string[];
    /** What the client wrote about what happened and what they want when they made the case. */
    notes?: string | null;
  };
  conversation: { from: "client" | "ai"; text: string }[];
  /** What Jev chooses from. */
  caseAreas: ReadinessAreaOption[];
}

export interface ReadinessAssessment {
  criteria: { key: ReadinessKey; label: string; met: boolean; confidence: number }[];
  /** The areas the problem falls under, each said YES with at least READINESS_MIN_CONFIDENCE, in
   * the order given. Empty when Jev isn't sure of any. */
  caseAreas: { code: string; confidence: number }[];
  personalInjury: { met: boolean; confidence: number };
}

/** Throws JevUnavailableError when Jev fails or times out; the caller then reports "couldn't
 * check", never "ready". */
export async function assessLawyerReadiness(input: ReadinessInput): Promise<ReadinessAssessment> {
  const conversation = input.conversation.slice(-MAX_MESSAGES).map((m) => ({ from: m.from, text: m.text.slice(0, MAX_MESSAGE_CHARS) }));
  const ruling = "`caseDetails.notes` is the client's own account of what happened and what they want, and counts like the conversation. Answer YES only if `caseDetails` or `conversation` actually show it; answer NO if it is missing or would have to be guessed. A short answer is not vague just for being short — if it's a direct, on-topic reply to a question the assistant actually asked, it counts, even in one word.";
  const question = Object.fromEntries(READINESS_CRITERIA.map((c) => [c.key, c.question])) as Record<ReadinessKey, string>;
  const ask = (key: ReadinessKey) => choice(`${question[key]} ${ruling}`, optionsInOrder(ANSWERS));
  const areaRuling = "A problem can fall under more than one area. `caseDetails.areas` is what the client picked and may be wrong.";

  const response = await jevAsk("lawyer-readiness", {
    state: { caseDetails: input.caseDetails, conversation },
    questions: {
      problem: ask("problem"),
      place: ask("place"),
      otherSide: ask("otherSide"),
      events: ask("events"),
      goal: ask("goal"),
      status: ask("status"),
      ...Object.fromEntries(
        input.caseAreas.map((a) => [
          areaKey(a.code),
          choice(`Does the client's problem need a solicitor for ${a.name}: ${a.description} ${areaRuling}`, optionsInOrder(ANSWERS)),
        ]),
      ),
      personalInjury: choice("Is the client's problem an injury someone else caused, such as an accident?", optionsInOrder(ANSWERS)),
    },
  });

  const answers = response.answers as Record<string, { choice: unknown; confidence: number }>;
  const yes = (key: string) => {
    const answer = answers[key];
    if (!answer) logger.warn("Lawyer readiness: Jev returned no answer for this question, treating as NO/0", { key });
    const raw = readChoice(answer?.choice, ANSWERS, "NO");
    const confidence = answer?.confidence ?? 0;
    return { met: applyFloor(raw, confidence, "YES", READINESS_MIN_CONFIDENCE, "NO").value === "YES", confidence };
  };
  const criteria = READINESS_CRITERIA.map((c) => ({ key: c.key, label: c.label, ...yes(c.key) }));
  const caseAreas = input.caseAreas
    .map((a) => ({ code: a.code, ...yes(areaKey(a.code)) }))
    .filter((a) => a.met)
    .map(({ code, confidence }) => ({ code, confidence }));
  const personalInjury = yes("personalInjury");
  logger.info("Lawyer readiness: Jev verdict", {
    criteria: criteria.map((c) => `${c.key}=${c.met ? "YES" : "NO"}(${c.confidence.toFixed(2)})`),
    caseAreas: caseAreas.map((a) => a.code),
    personalInjury: personalInjury.met,
  });
  return { criteria, caseAreas, personalInjury };
}
