import { choice } from "@typesafe-ai/sdk";
import { getTypeSafeClient } from "./typesafeClient";
import logger from "./logger";

/**
 * Jev as a gate before an event is checked against its source: is the proposition stated as a fact
 * about the world, or does it only report that someone said something? "Abandonment is alleged to
 * begin on 4 August" cannot be checked against payroll — payroll doesn't contradict that an
 * allegation was made — so it comes back UNSUPPORTED and reads as noise (benchmarks/reconstruction,
 * case E11). The event generator is told not to write those (case-reconstruction-events-prompt.ts);
 * this catches the ones that slip through, so the service can flag the event instead of running a
 * check that cannot answer the question.
 *
 * Throws on a Jev failure — the caller then simply runs the ordinary check, which is safe.
 */

export const EVENT_PHRASINGS = ["FACT", "ALLEGATION"] as const;
export type EventPhrasing = (typeof EVENT_PHRASINGS)[number];

/**
 * ALLEGATION is the verdict that skips the source check, so a wrong one hides a real Verified or
 * Disputed. Below this confidence it is recorded as FACT and the event goes through the ordinary
 * check. Provisional: re-set from the phrasing cases in the benchmark.
 */
export const ALLEGATION_MIN_CONFIDENCE = 0.7;

const PHRASING_DEFINITIONS: Record<EventPhrasing, string> = {
  FACT: "the sentence states that something happened or was the case — an act, an event, a document's content, a state of affairs — as its own claim, even if the fact is disputed elsewhere",
  ALLEGATION:
    "the sentence only reports that someone alleged, claimed, asserted, contended or purported something (\"X is alleged to…\", \"Acme says…\", \"she supposedly…\") — it is about the claim being made, not about the thing claimed",
};

export interface EventPhrasingCheck {
  /** After the confidence floor — what to act on. */
  phrasing: EventPhrasing;
  confidence: number;
  /** Jev's own answer, before the floor. */
  rawPhrasing: EventPhrasing;
}

export async function classifyEventPhrasingWithJev(proposition: string): Promise<EventPhrasingCheck> {
  const client = getTypeSafeClient();
  logger.info("Jev request", { feature: "event-phrasing", chars: proposition.length });
  const response = await client.systemOne({
    state: { proposition },
    questions: {
      phrasing: choice(
        "`proposition` is one entry in a case's event chain. Classify how it is phrased, not whether it is true:\n" +
          EVENT_PHRASINGS.map((p) => `${p} — ${PHRASING_DEFINITIONS[p]}`).join("\n"),
        Object.fromEntries(EVENT_PHRASINGS.map((p) => [p, null])) as Record<EventPhrasing, null>,
      ),
    },
  });

  const answer = response.answers.phrasing;
  const raw: EventPhrasing = (EVENT_PHRASINGS as readonly string[]).includes(answer.choice as string) ? (answer.choice as EventPhrasing) : "FACT";
  const downgraded = raw === "ALLEGATION" && answer.confidence < ALLEGATION_MIN_CONFIDENCE;
  const phrasing: EventPhrasing = downgraded ? "FACT" : raw;
  logger.info("Jev response", { feature: "event-phrasing", phrasing, rawPhrasing: raw, downgraded, confidence: answer.confidence });
  return { phrasing, confidence: answer.confidence, rawPhrasing: raw };
}
