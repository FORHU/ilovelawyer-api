import { noul } from "@typesafe-ai/sdk";
import { getTypeSafeClient } from "./typesafeClient";
import logger from "./logger";

/** Pilot flag — see docs/Jev integration doc. Unset/false: no triage call at all. */
const USE_JEV_MESSAGE_TRIAGE = process.env.USE_JEV_MESSAGE_TRIAGE === "true";

export interface UrgencyFlag {
  urgent: boolean;
  probability: number;
}

/** Classifies a single incoming consultation/case chat message for urgency — logged only for
 * now (see chat.service.ts's enqueueChatGeneration), no DB column exists yet to persist this
 * against. Never throws: a failed/unavailable call just skips triage, same as every other
 * best-effort AI-derived signal in this codebase. */
export async function flagMessageUrgency(userInput: string): Promise<UrgencyFlag | null> {
  if (!USE_JEV_MESSAGE_TRIAGE) return null;
  const message = userInput?.trim();
  if (!message) return null;

  try {
    const client = getTypeSafeClient();
    const response = await client.systemOne({
      state: { message },
      questions: {
        urgency: noul("Does this message express urgency — a time-sensitive deadline, an imminent hearing, or an emergency situation requiring prompt attention?"),
      },
    });
    const answer = response.answers.urgency;
    const urgent = answer.noul >= 0.5;
    logger.info("Jev message urgency response", { urgent, probability: answer.noul });
    return { urgent, probability: answer.noul };
  } catch (err) {
    logger.warn("Jev message urgency classification failed", { err });
    return null;
  }
}
