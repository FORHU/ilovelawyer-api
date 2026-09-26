import { choice } from "@typesafe-ai/sdk";
import { getTypeSafeClient } from "./typesafeClient";
import logger from "./logger";

export type AuthorityStanceValue = "STATUTE" | "ON_POINT" | "ADVERSE";

/** Below this the suggestion isn't worth a lawyer's attention — same idea as the grounding
 * verifier's floor for accusatory verdicts. The app mirrors this value for the row chip. */
export const AUTHORITY_JEV_MIN_CONFIDENCE = 0.7;

/** Jev calls are inline in POST /authorities, so a slow one must not hold up the save. */
const JEV_TIMEOUT_MS = 8000;
/** Characters of the resolved law's text handed to Jev. */
const LAW_TEXT_MAX_CHARS = 3000;

export interface AuthorityJevInput {
  ground: string | null;
  title: string;
  subtitle?: string | null;
  citation?: string | null;
  rationale?: string | null;
  /** Summary / facts / disposition of the Law row the citation resolved to, if any. */
  lawText?: string | null;
}

/** Off unless USE_JEV_AUTHORITY=true — see .env.example. Read per call so a test can flip it. */
export function isAuthorityJevEnabled() {
  return process.env.USE_JEV_AUTHORITY === "true";
}

/** The fields Jev sees. Empty ones are dropped and the law text capped, so the prompt only carries
 * what the lawyer or the corpus actually supplied. */
export function buildAuthorityState(input: AuthorityJevInput): Record<string, string> {
  const state: Record<string, string> = { authority: input.title.trim() };
  const optional: [string, string | null | undefined][] = [
    ["ground", input.ground],
    ["subtitle", input.subtitle],
    ["citation", input.citation],
    ["lawyerNote", input.rationale],
    ["sourceText", input.lawText?.slice(0, LAW_TEXT_MAX_CHARS)],
  ];
  for (const [key, value] of optional) {
    if (value?.trim()) state[key] = value.trim();
  }
  return state;
}

/** Second opinion on how an authority bears on a ground. Returns null when the flag is off, Jev
 * errors or times out — the caller saves the row either way. */
export async function suggestAuthorityStance(
  input: AuthorityJevInput,
): Promise<{ stance: AuthorityStanceValue; confidence: number } | null> {
  if (!isAuthorityJevEnabled()) return null;

  try {
    const state = buildAuthorityState(input);
    logger.info("Jev request", { feature: "authority-stance", question: "stance", state });
    const call = getTypeSafeClient().systemOne({
      state,
      questions: {
        stance: choice(
          "A lawyer relies on `authority` for their case's `ground` (when given). Classify how it bears on the lawyer's own side: STATUTE if it is a statute, rule or regulation that sets the governing law without itself favouring either side; ON_POINT if it directly supports the lawyer's side on that ground; ADVERSE if the opposing party could rely on it or it undercuts the lawyer's position.",
          { STATUTE: null, ON_POINT: null, ADVERSE: null },
        ),
      },
    });
    const response = await Promise.race([
      call,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Jev timeout")), JEV_TIMEOUT_MS)),
    ]);
    const answer = response.answers.stance;
    logger.info("Jev response", {
      feature: "authority-stance",
      choice: answer.choice,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
    });
    return { stance: answer.choice, confidence: answer.confidence };
  } catch (err) {
    logger.warn("Jev error", { feature: "authority-stance", err });
    return null;
  }
}
