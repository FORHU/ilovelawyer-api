import { choice } from "@typesafe-ai/sdk";
import { jevAsk } from "./typesafeClient";
import { applyFloor, optionsInOrder, readChoice } from "./jev-common";
import { CLIENT_CASE_AREAS } from "../constants/client-case.constants";

/**
 * Jev deciding when a client's case has enough in it to suggest a lawyer (the client app). One
 * yes/no question per thing a solicitor needs before picking a case up, each with Jev's confidence,
 * so the client can see exactly what's known and what's missing, never just "not yet". Plus which
 * kind of lawyer the problem needs, which lawyer matching uses.
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
    question: "Is it clear who the client's problem is with: a named or clearly identified person, employer, landlord, business or organisation?",
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
    question: "Has the client said what outcome they want, for example compensation, their job back, a refund, repairs, or to defend a claim against them?",
  },
] as const;

export type ReadinessKey = (typeof READINESS_CRITERIA)[number]["key"];

/** Jev must be at least this sure a point is covered for it to count. Provisional: set it from a
 * benchmark of real client conversations before relying on it outside staging. */
export const READINESS_MIN_CONFIDENCE = 0.7;

/** Personal injury is recognised only so it can be left out: referral fees are banned there. */
export const READINESS_AREAS = [...CLIENT_CASE_AREAS, "PERSONAL_INJURY"] as const;
export type ReadinessArea = (typeof READINESS_AREAS)[number];

const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 1500;

/** NO first: Jev leans toward the first option listed (jev-common.ts), and a missed suggestion
 * costs less than suggesting a lawyer too early. */
const ANSWERS = ["NO", "YES"] as const;

export interface ReadinessInput {
  caseDetails: {
    title: string;
    area: string | null;
    ukJurisdiction: string | null;
    where: string | null;
    side: string | null;
    otherParties: string[];
  };
  conversation: { from: "client" | "ai"; text: string }[];
}

export interface ReadinessAssessment {
  criteria: { key: ReadinessKey; label: string; met: boolean; confidence: number }[];
  practiceArea: { value: ReadinessArea; confidence: number };
}

/** Throws JevUnavailableError when Jev fails or times out; the caller then reports "couldn't
 * check", never "ready". */
export async function assessLawyerReadiness(input: ReadinessInput): Promise<ReadinessAssessment> {
  const conversation = input.conversation.slice(-MAX_MESSAGES).map((m) => ({ from: m.from, text: m.text.slice(0, MAX_MESSAGE_CHARS) }));
  const ruling = "Answer YES only if `caseDetails` or `conversation` actually show it; answer NO if it is missing, vague, or would have to be guessed.";
  const question = Object.fromEntries(READINESS_CRITERIA.map((c) => [c.key, c.question])) as Record<ReadinessKey, string>;
  const ask = (key: ReadinessKey) => choice(`${question[key]} ${ruling}`, optionsInOrder(ANSWERS));

  const response = await jevAsk("lawyer-readiness", {
    state: { caseDetails: input.caseDetails, conversation },
    questions: {
      problem: ask("problem"),
      place: ask("place"),
      otherSide: ask("otherSide"),
      events: ask("events"),
      goal: ask("goal"),
      practiceArea: choice(
        "Which kind of solicitor does the client's problem need? EMPLOYMENT: work, dismissal, pay, discrimination at work. PROPERTY: renting, landlords, deposits, buying or owning a home, neighbours. FAMILY: divorce, separation, children. CONSUMER: goods, services, refunds, problems with a business. PERSONAL_INJURY: an injury someone else caused, such as an accident. OTHER: anything else. `caseDetails.area` is what the client picked and may be wrong.",
        optionsInOrder(READINESS_AREAS),
      ),
    },
  });

  const answers = response.answers as Record<string, { choice: unknown; confidence: number }>;
  return {
    criteria: READINESS_CRITERIA.map((c) => {
      const answer = answers[c.key];
      const raw = readChoice(answer?.choice, ANSWERS, "NO");
      const { value } = applyFloor(raw, answer?.confidence ?? 0, "YES", READINESS_MIN_CONFIDENCE, "NO");
      return { key: c.key, label: c.label, met: value === "YES", confidence: answer?.confidence ?? 0 };
    }),
    practiceArea: {
      value: readChoice(answers.practiceArea?.choice, READINESS_AREAS, "OTHER"),
      confidence: answers.practiceArea?.confidence ?? 0,
    },
  };
}
