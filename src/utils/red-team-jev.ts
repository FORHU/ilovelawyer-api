import { choice, score } from "@typesafe-ai/sdk";
import { getTypeSafeClient } from "./typesafeClient";
import logger from "./logger";
import { applyFloor, isUncertain, normalizeScore, readChoice } from "./jev-common";
import { caseDataState, CaseJevContext } from "./case-jev-context";
import type { RedTeamArgument, RedTeamArguments, RedTeamArgumentStrength } from "./red-team-arguments-parse";

/**
 * Jev as the verifier behind the Red Team panel's ranked arguments. Chat Wonder still writes the
 * assessment and the arguments (Jev doesn't generate text); Jev then judges each argument against
 * the case data it cites, and the panel's strength label and impact number are computed here from
 * those judgments instead of being the author model's self-rating:
 *
 *   - support    Choice — does the cited case item bear out the argument's premise?
 *   - likelihood Score  — how likely a court is to accept it (0..3, concrete situations)
 *   - severity   Score  — how much of the user's case it disposes of if accepted (0..3)
 *
 * All three are asked in one request per argument; arguments run in parallel. Off unless
 * USE_JEV_REDTEAM=true — gated like the other Jev pilots until scripts/jev-red-team-benchmark.ts
 * has been run against lawyer-labelled arguments.
 */

export function isRedTeamJevEnabled(): boolean {
  return process.env.USE_JEV_REDTEAM === "true";
}

export const SUPPORT_VERDICTS = ["SUPPORTED", "UNSUPPORTED", "CONTRADICTED"] as const;
export type SupportVerdict = (typeof SUPPORT_VERDICTS)[number];

/** Same rule and reason as assertion-check.ts's floor: CONTRADICTED is the accusatory verdict, so
 * below this it's reported as UNSUPPORTED. Provisional — re-set from the red-team benchmark. */
export const CONTRADICTION_MIN_CONFIDENCE = 0.7;

// Ordered lowest → highest, as Score requires. Concrete situations, no numbers (see the Score docs).
export const LIKELIHOOD_LEVELS = [
  "The argument depends on a fact the case data contradicts, or on a rule that plainly does not apply to these facts, so a court would reject it.",
  "The argument rests on inference or on a contested fact with little in the case data behind it; a court would probably not accept it.",
  "The argument has real support in the case data, but the user has a credible answer to it, so it could go either way.",
  "The argument rests on facts the case data shows as undisputed or documented, and on a rule that clearly applies to them, so a court would likely accept it.",
] as const;

export const SEVERITY_LEVELS = [
  "Even if accepted, it only dents a witness's credibility or a side point; the user's claims and remedies are unaffected.",
  "If accepted, it reduces the damages or remedies the user can recover, but leaves liability intact.",
  "If accepted, it defeats one element of a claim, or one of several claims, but the user's case survives in part.",
  "If accepted, it disposes of the whole case — for example dismissal on a procedural ground, or a complete defence to liability.",
] as const;

export type RedTeamJevContext = CaseJevContext;

export interface RedTeamJevRating {
  support: SupportVerdict;
  supportConfidence: number;
  /** 0..1 — Score position normalized by the top level. */
  likelihood: number;
  likelihoodConfidence: number;
  severity: number;
  severityConfidence: number;
  /** True when either Score's confidence is under UNCERTAIN_SCORE_CONFIDENCE. */
  uncertain: boolean;
}

export type VerifiedRedTeamArgument = RedTeamArgument & {
  /** Null when Jev wasn't run for this argument or its call failed — strength/impact are then
   * the author model's own, as before. */
  jev: RedTeamJevRating | null;
  /** The author model's own rating, kept alongside Jev's for comparison. Only set when `jev` is. */
  modelStrength?: RedTeamArgumentStrength;
  modelImpact?: number;
};

export interface VerifiedRedTeamArguments extends Omit<RedTeamArguments, "arguments"> {
  arguments: VerifiedRedTeamArgument[];
}

/** Strength label from the likelihood Score alone — the label answers "will this work?". */
export function strengthFromLikelihood(likelihood: number): RedTeamArgumentStrength {
  if (likelihood >= 2 / 3) return "STRONG";
  if (likelihood >= 1 / 3) return "MODERATE";
  return "WEAK";
}

/**
 * Impact on the panel's -10..10 scale: severity scaled by how far the likelihood sits from a
 * coin-flip. A likely argument that would end the case is +10; one that's likely to fail is
 * negative (the opponent spends credibility on it); anything that barely matters sits near 0
 * whichever way it goes. An argument whose cited item doesn't support it can't score above 0.
 */
export function impactFromRatings(likelihood: number, severity: number, support: SupportVerdict): number {
  const raw = Math.round(10 * (2 * likelihood - 1) * severity);
  const clamped = Math.max(-10, Math.min(10, raw));
  return support === "SUPPORTED" ? clamped : Math.min(0, clamped);
}

/** Throws on a Jev failure — verifyRedTeamArgumentsWithJev decides what that means. */
export async function rateArgumentWithJev(arg: RedTeamArgument, context: RedTeamJevContext): Promise<RedTeamJevRating> {
  const client = getTypeSafeClient();
  const state = {
    opponent: context.opponent ?? "the opposing party",
    argument: { title: arg.title, gist: arg.gist ?? "", reasoning: arg.reasoning ?? "" },
    citedItem: { kind: arg.source.kind, text: arg.source.label },
    caseData: caseDataState(context),
  };
  logger.info("Jev request", { feature: "red-team", title: arg.title, sourceKind: arg.source.kind });

  const response = await client.systemOne({
    state,
    questions: {
      support: choice(
        "`opponent` intends to raise `argument` against the user and says it rests on `citedItem`, which is an item from the user's own case data. Classify the relationship between `citedItem` and the factual premise of `argument`: SUPPORTED if `citedItem` bears out that premise, even if worded differently; UNSUPPORTED if `citedItem` does not address or does not establish it; CONTRADICTED if `citedItem`, read with `caseData`, says the opposite of that premise.",
        { SUPPORTED: null, UNSUPPORTED: null, CONTRADICTED: null },
      ),
      likelihood: score(
        "Judging only from `caseData` and `citedItem`, how likely is a court to accept `argument` if `opponent` raises it? Do not use facts that are not in the state.",
        [...LIKELIHOOD_LEVELS],
      ),
      severity: score(
        "Suppose a court accepts `argument`. How much of the user's case does it dispose of, given the claims and issues in `caseData`?",
        [...SEVERITY_LEVELS],
      ),
    },
  });

  const s = response.answers.support;
  const raw = readChoice<SupportVerdict>(s.choice, SUPPORT_VERDICTS, "UNSUPPORTED");
  const { value: support, downgraded } = applyFloor(raw, s.confidence, "CONTRADICTED", CONTRADICTION_MIN_CONFIDENCE, "UNSUPPORTED");
  const rating: RedTeamJevRating = {
    support,
    supportConfidence: s.confidence,
    likelihood: normalizeScore(response.answers.likelihood.score, LIKELIHOOD_LEVELS),
    likelihoodConfidence: response.answers.likelihood.confidence,
    severity: normalizeScore(response.answers.severity.score, SEVERITY_LEVELS),
    severityConfidence: response.answers.severity.confidence,
    uncertain: isUncertain(response.answers.likelihood.confidence, response.answers.severity.confidence),
  };

  logger.info("Jev response", {
    feature: "red-team",
    title: arg.title,
    ...rating,
    // Logged so a floor-triggered downgrade is visible in the trace, not mistaken for UNSUPPORTED.
    rawSupport: raw,
    downgraded,
  });
  return rating;
}

/**
 * Rates every argument in parallel and replaces strength/impact with the Jev-derived values,
 * keeping the author model's own as modelStrength/modelImpact. A failed call leaves that one
 * argument on its model rating with jev: null — the panel then shows it as not verified rather
 * than pretending it was. Never throws: the assessment itself must still save.
 */
export async function verifyRedTeamArgumentsWithJev(
  args: RedTeamArguments,
  context: RedTeamJevContext,
): Promise<VerifiedRedTeamArguments> {
  const verified = await Promise.all(
    args.arguments.map(async (arg): Promise<VerifiedRedTeamArgument> => {
      try {
        const jev = await rateArgumentWithJev(arg, context);
        return {
          ...arg,
          jev,
          strength: strengthFromLikelihood(jev.likelihood),
          impact: impactFromRatings(jev.likelihood, jev.severity, jev.support),
          modelStrength: arg.strength,
          modelImpact: arg.impact,
        };
      } catch (err) {
        logger.warn("Red team: Jev rating failed for one argument, keeping the model's rating", { err, title: arg.title });
        return { ...arg, jev: null };
      }
    }),
  );
  verified.sort((a, b) => b.impact - a.impact);
  return { ...args, arguments: verified };
}
