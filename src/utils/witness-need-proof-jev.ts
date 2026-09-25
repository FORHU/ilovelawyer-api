import { choice } from "@typesafe-ai/sdk";
import { getTypeSafeClient } from "./typesafeClient";
import logger from "./logger";

/**
 * Does the document or photo a lawyer attached actually show what a "what's needed" item asks
 * for? Jev reads the requirement and the document's extracted text and classifies the fit, so a
 * tick can't be backed by an unrelated file. A mismatch is refused; anything
 * the app can't judge (a photo with no readable text, a partial fit) is accepted but marked as not
 * confirmed, so it never reads as verified.
 */

export const PROOF_VERDICTS = ["SATISFIES", "PARTLY", "DOES_NOT_SATISFY", "CANNOT_TELL"] as const;
export type ProofVerdict = (typeof PROOF_VERDICTS)[number];

/** What is stored on a tick. DOES_NOT_SATISFY is never stored, because it refuses the tick. */
export type ProofMatch = { verdict: Exclude<ProofVerdict, "DOES_NOT_SATISFY">; confidence: number };

/** Below this confidence a match is shown as "not confirmed" rather than "matches". Provisional. */
export const PROOF_CONFIRM_MIN_CONFIDENCE = 0.6;

const MAX_TEXT = 8000;

const DEFINITIONS: Record<ProofVerdict, string> = {
  SATISFIES: "the document contains what the requirement asks for, or clearly is that item",
  PARTLY: "the document covers some of what the requirement asks for but not all of it",
  DOES_NOT_SATISFY: "the document is about something else and does not contain what the requirement asks for",
  CANNOT_TELL: "the document has no readable text, or too little, to judge either way",
};

export interface ProofCheckInput {
  requirement: string;
  document: { name: string; category: string | null; summary: string | null; text: string | null };
}

/** Never throws: a Jev failure is reported as CANNOT_TELL so the tick is accepted, unconfirmed. */
export async function checkProofWithJev(input: ProofCheckInput): Promise<{ verdict: ProofVerdict; confidence: number }> {
  if (!input.document.text || input.document.text.trim().length < 20) {
    return { verdict: "CANNOT_TELL", confidence: 1 };
  }
  try {
    const client = getTypeSafeClient();
    logger.info("Jev request", { feature: "witness-need-proof", document: input.document.name });
    const response = await client.systemOne({
      state: {
        requirement: input.requirement,
        document: {
          name: input.document.name,
          category: input.document.category ?? "",
          summary: input.document.summary ?? "",
          text: input.document.text.slice(0, MAX_TEXT),
        },
      },
      questions: {
        fit: choice(
          "A lawyer says they have done what `requirement` asks and attached `document` as proof. Reading only `document`, decide whether it shows that:\n" +
            PROOF_VERDICTS.map((v) => `${v} - ${DEFINITIONS[v]}`).join("\n"),
          Object.fromEntries(PROOF_VERDICTS.map((v) => [v, null])) as Record<ProofVerdict, null>,
        ),
      },
    });
    const answer = response.answers.fit;
    const verdict = (PROOF_VERDICTS as readonly string[]).includes(answer.choice as string)
      ? (answer.choice as ProofVerdict)
      : "CANNOT_TELL";
    logger.info("Jev response", { feature: "witness-need-proof", verdict, confidence: answer.confidence });
    return { verdict, confidence: answer.confidence };
  } catch (err) {
    logger.warn("Witness need proof: Jev failed, accepting the tick as unconfirmed", { err });
    return { verdict: "CANNOT_TELL", confidence: 0 };
  }
}

/** Any mismatch refuses the tick: the proof has to show what the item asks for. A match, a partial
 * fit or an unreadable file is stored with what Jev said; the panel only calls it a match when the
 * confidence reaches PROOF_CONFIRM_MIN_CONFIDENCE. */
export function toStoredMatch(result: { verdict: ProofVerdict; confidence: number }): ProofMatch | "REFUSE" {
  if (result.verdict === "DOES_NOT_SATISFY") return "REFUSE";
  return { verdict: result.verdict, confidence: result.confidence };
}
