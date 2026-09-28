import { choice } from "@typesafe-ai/sdk";
import { getTypeSafeClient } from "./typesafeClient";
import type { AudioOverviewTurn } from "./response-parser";
import { CONTRADICTION_MIN_CONFIDENCE, SUPPORT_VERDICTS, type MindMapJevContext, type SupportVerdict } from "./mind-map-jev";
import logger from "./logger";

/**
 * Jev as the verifier behind Audio Overview, the way it verifies the case mind map
 * (mind-map-jev.ts): chat-wonder writes the two-host script; Jev then judges each turn against
 * the case data — the same context the mind map and Red Team are judged against — and the
 * verdicts are stored beside the script and shown in the player. Jev never rewrites a turn.
 *
 * Off unless USE_JEV_AUDIO_OVERVIEW=true.
 */
export function isAudioOverviewJevEnabled(): boolean {
  return process.env.USE_JEV_AUDIO_OVERVIEW === "true";
}

/** A turn is either a claim about the case (judged) or conversational filler — "Great question,
 * let's dig in" — which nothing in the case data can bear out and would only be flagged for no
 * reason, so Jev is offered that as an answer and such turns get no verdict. */
const TURN_ANSWERS = [...SUPPORT_VERDICTS, "NOT_A_CLAIM"] as const;

/** Jev calls in flight at once — this runs in the background after the script is saved. */
const CONCURRENCY = 5;
const MAX_CONTEXT_ITEMS = 25;

export interface AudioOverviewTurnCheck {
  /** Index into the script's `turns`. Turns are never edited after saving, so it stays valid. */
  turn: number;
  verdict: SupportVerdict;
  confidence: number;
  checkedAt: string;
}

function clip<T>(items: T[]): T[] {
  return items.slice(0, MAX_CONTEXT_ITEMS);
}

/** Jev's read of one turn, or null when the turn asserts nothing about the case. Throws on a Jev
 * failure. CONTRADICTED below CONTRADICTION_MIN_CONFIDENCE is reported as UNSUPPORTED, same
 * floor and reason as the mind map. */
export async function judgeAudioOverviewTurn(
  text: string,
  context: MindMapJevContext,
): Promise<{ verdict: SupportVerdict; confidence: number } | null> {
  const response = await getTypeSafeClient().systemOne({
    state: {
      turn: text,
      caseData: {
        parties: clip(context.parties),
        legalIssues: clip(context.legalIssues),
        strengths: clip(context.strengths),
        weaknesses: clip(context.weaknesses),
        contradictions: clip(context.contradictions),
        timeline: clip(context.timeline),
        witnesses: clip(context.witnesses),
        damages: clip(context.damages),
      },
    },
    questions: {
      support: choice(
        "`turn` is one line of a podcast-style discussion of this case. If it states nothing about the case's facts, parties, dates, issues or evidence (greetings, transitions, questions, general legal explanation), answer NOT_A_CLAIM. Otherwise classify the relationship between `caseData` and what `turn` states: SUPPORTED if `caseData` bears it out, even if worded differently; UNSUPPORTED if it does not address or establish it; CONTRADICTED if it says the opposite. Do not use facts that are not in the state.",
        { SUPPORTED: null, UNSUPPORTED: null, CONTRADICTED: null, NOT_A_CLAIM: null },
      ),
    },
  });
  const s = response.answers.support;
  const answer = (TURN_ANSWERS as readonly string[]).includes(s.choice as string) ? (s.choice as (typeof TURN_ANSWERS)[number]) : "UNSUPPORTED";
  if (answer === "NOT_A_CLAIM") return null;
  const downgraded = answer === "CONTRADICTED" && s.confidence < CONTRADICTION_MIN_CONFIDENCE;
  return { verdict: downgraded ? "UNSUPPORTED" : answer, confidence: s.confidence };
}

/** Checks every turn, CONCURRENCY at a time, in script order. A turn whose Jev call fails is left
 * unchecked and logged, never marked — "we couldn't check" must not read as a verdict. */
export async function checkAudioOverviewTurns(
  turns: AudioOverviewTurn[],
  context: MindMapJevContext,
): Promise<AudioOverviewTurnCheck[]> {
  const checks: AudioOverviewTurnCheck[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, turns.length) }, async () => {
      for (;;) {
        const index = next++;
        const turn = turns[index];
        if (!turn) return;
        try {
          const judged = await judgeAudioOverviewTurn(turn.text, context);
          if (judged) checks.push({ turn: index, ...judged, checkedAt: new Date().toISOString() });
        } catch (err) {
          logger.warn("Audio Overview Jev check failed, leaving the turn unchecked", { err, turn: index });
        }
      }
    }),
  );
  return checks.sort((a, b) => a.turn - b.turn);
}
