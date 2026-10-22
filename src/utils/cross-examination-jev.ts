import { choice } from "@typesafe-ai/sdk";
import { jevAsk } from "./typesafeClient";
import logger from "./logger";

/**
 * Does the passage a cross-examination question rests on actually support the fact the question
 * puts to the witness? The quote itself was already found in its document (CrossExaminationSvc),
 * so this checks the step after that: that the question doesn't put more than the passage says.
 * A question that fails is kept and shown as not supported, never hidden, so the lawyer sees why.
 */

export const SUPPORT_VERDICTS = ["SUPPORTS", "PARTLY", "DOES_NOT_SUPPORT", "CANNOT_TELL"] as const;
export type SupportVerdict = (typeof SUPPORT_VERDICTS)[number];

/** Below this confidence a SUPPORTS verdict is shown as "not confirmed". Provisional, as
 * PROOF_CONFIRM_MIN_CONFIDENCE is. */
export const SUPPORT_CONFIRM_MIN_CONFIDENCE = 0.6;

const DEFINITIONS: Record<SupportVerdict, string> = {
  SUPPORTS: "the passage states the fact the question puts, so the witness can be held to it",
  PARTLY: "the passage states part of the fact the question puts, but the question adds something it does not say",
  DOES_NOT_SUPPORT: "the passage does not state the fact the question puts, or says the opposite",
  CANNOT_TELL: "the passage is too short or unclear to judge either way",
};

export interface SupportCheckInput {
  question: string;
  quote: string;
  documentName: string;
}

/** Never throws: a Jev failure is reported as CANNOT_TELL with confidence 0, so the row still
 * shows, unconfirmed. */
export async function checkCrossExamSupportWithJev(
  input: SupportCheckInput,
): Promise<{ verdict: SupportVerdict; confidence: number }> {
  try {
    logger.info("Jev request", { feature: "cross-examination-support", document: input.documentName });
    const response = await jevAsk("cross-examination-support", {
      state: {
        question: input.question,
        passage: { document: input.documentName, text: input.quote },
      },
      questions: {
        support: choice(
          "An advocate will put `question` to a witness in cross-examination, relying on `passage`. Reading only `passage`, decide whether it supports the fact the question puts:\n" +
            SUPPORT_VERDICTS.map((v) => `${v} - ${DEFINITIONS[v]}`).join("\n"),
          Object.fromEntries(SUPPORT_VERDICTS.map((v) => [v, null])) as Record<SupportVerdict, null>,
        ),
      },
    });
    const answer = response.answers.support;
    const verdict = (SUPPORT_VERDICTS as readonly string[]).includes(answer.choice as string)
      ? (answer.choice as SupportVerdict)
      : "CANNOT_TELL";
    logger.info("Jev response", { feature: "cross-examination-support", verdict, confidence: answer.confidence });
    return { verdict, confidence: answer.confidence };
  } catch (err) {
    logger.warn("Cross-examination support: Jev failed, leaving the question unconfirmed", { err });
    return { verdict: "CANNOT_TELL", confidence: 0 };
  }
}
