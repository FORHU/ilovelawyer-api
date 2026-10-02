import { choice } from "@typesafe-ai/sdk";
import { getTypeSafeClient } from "./typesafeClient";
import logger from "./logger";
import { JevRating, JevVerdict, Level, RankableAuthority } from "./citation-rank";

/** Off unless USE_JEV_CITATION_RANK=true — see .env.example. Read per call so a test can flip it. */
export function isCitationRankJevEnabled() {
  return process.env.USE_JEV_CITATION_RANK === "true";
}

/** A systemOne call fails with max_tokens_exceeded past roughly 64k input tokens (measured in Phase 0:
 * 62.9k passed, about 70k failed). Stay well under it. */
export const BATCH_INPUT_TOKEN_BUDGET = 40_000;
/** Measured: about 120 tokens of question text per question, two questions per authority. */
const QUESTION_TOKENS_PER_AUTHORITY = 240;
/** Characters of the authority's own text handed to Jev (the authority-stance pilot uses 3000). */
export const AUTHORITY_TEXT_MAX_CHARS = 1500;
const MESSAGE_MAX_CHARS = 4000;
const JEV_TIMEOUT_MS = 8000;

const LEVELS: Record<Level, null> = { HIGH: null, MEDIUM: null, LOW: null };
const LEVEL_SET = new Set<string>(["HIGH", "MEDIUM", "LOW"]);

const estimateTokens = (chars: number) => Math.ceil(chars / 4);

function describe(a: RankableAuthority): string {
  const head = [a.label, a.kind, a.year ? String(a.year) : null].filter(Boolean).join(" | ");
  const text = a.text?.trim().slice(0, AUTHORITY_TEXT_MAX_CHARS);
  return text ? `${head}\n${text}` : head;
}

/** Splits into batches that each stay under the input-token budget. The user's message is paid once
 * per batch; each authority once. Order is preserved. */
export function batchAuthorities(
  authorities: RankableAuthority[],
  messageChars: number,
  budgetTokens = BATCH_INPUT_TOKEN_BUDGET,
): RankableAuthority[][] {
  const batches: RankableAuthority[][] = [];
  let current: RankableAuthority[] = [];
  let used = estimateTokens(messageChars);
  for (const a of authorities) {
    const cost = estimateTokens(describe(a).length) + QUESTION_TOKENS_PER_AUTHORITY;
    if (current.length && used + cost > budgetTokens) {
      batches.push(current);
      current = [];
      used = estimateTokens(messageChars);
    }
    current.push(a);
    used += cost;
  }
  if (current.length) batches.push(current);
  return batches;
}

/** Everything Jev sees for one batch. The answer's own text is never part of it: an answer that is
 * wrong must not raise the rating of the authorities it cites. */
export function buildBatch(userMessage: string, caseContext: string | null | undefined, batch: RankableAuthority[]) {
  const state: Record<string, string> = { message: userMessage.trim().slice(0, MESSAGE_MAX_CHARS) };
  if (caseContext?.trim()) state.caseContext = caseContext.trim().slice(0, MESSAGE_MAX_CHARS);
  const questions: Record<string, ReturnType<typeof choice>> = {};
  batch.forEach((a, i) => {
    state[`authority_${i}`] = describe(a);
    questions[`rel_${i}`] = choice(
      `A user wrote \`message\`. How directly does \`authority_${i}\` address what they asked or the situation they describe? HIGH = squarely on it. MEDIUM = bears on a sub-issue. LOW = tangential or only general background. Judge the authority against the user's situation, not against anyone's answer.`,
      LEVELS,
    );
    questions[`imp_${i}`] = choice(
      `A lawyer is about to advise the user who wrote \`message\`. Would they need to read \`authority_${i}\` before advising? HIGH = yes, it is controlling or essential. MEDIUM = they would read it if time allows. LOW = not needed to advise on these facts.`,
      LEVELS,
    );
  });
  return { state, questions };
}

function verdictOf(answer: any): JevVerdict | null {
  const c = answer?.choice;
  if (!LEVEL_SET.has(c)) return null;
  const p = answer?.probabilities?.[c];
  const top = typeof p === "number" ? p : typeof answer?.confidence === "number" ? answer.confidence : 0;
  return { choice: c as Level, topProbability: top };
}

/** Reads one batch's response back into ratings keyed by authority id. Pure: the network call is
 * rankBatch. A missing or malformed answer leaves that axis null, which combineTier treats as no signal. */
export function parseBatch(batch: RankableAuthority[], answers: Record<string, unknown> | undefined): Map<string, JevRating> {
  const out = new Map<string, JevRating>();
  batch.forEach((a, i) => {
    out.set(a.id, { relevance: verdictOf(answers?.[`rel_${i}`]), importance: verdictOf(answers?.[`imp_${i}`]) });
  });
  return out;
}

async function rankBatch(userMessage: string, caseContext: string | null | undefined, batch: RankableAuthority[]): Promise<Map<string, JevRating>> {
  const { state, questions } = buildBatch(userMessage, caseContext, batch);
  logger.info("Jev request", { feature: "citation-rank", authorities: batch.length, questions: Object.keys(questions).length });
  const call = getTypeSafeClient().systemOne({ state, questions });
  const response: any = await Promise.race([
    call,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Jev timeout")), JEV_TIMEOUT_MS)),
  ]);
  const parsed = parseBatch(batch, response.answers);
  logger.info("Jev response", {
    feature: "citation-rank",
    authorities: batch.length,
    usage: response.usage,
    rated: [...parsed.values()].filter((r) => r.relevance && r.importance).length,
  });
  return parsed;
}

/**
 * Jev's relevance and importance reading of each authority against the user's message. Returns null
 * when the flag is off. A batch that errors or times out leaves its authorities unrated (decision D8:
 * neutral colour) while the other batches still count. Never throws.
 */
export async function rateAuthoritiesWithJev(
  userMessage: string,
  authorities: RankableAuthority[],
  caseContext?: string | null,
): Promise<Map<string, JevRating> | null> {
  if (!isCitationRankJevEnabled()) return null;
  const message = userMessage?.trim();
  if (!message || !authorities.length) return new Map();

  const batches = batchAuthorities(authorities, Math.min(message.length, MESSAGE_MAX_CHARS) + (caseContext?.length ?? 0));
  const results = await Promise.all(
    batches.map(async (batch) => {
      try {
        return await rankBatch(message, caseContext, batch);
      } catch (err) {
        logger.warn("Jev error", { feature: "citation-rank", authorities: batch.length, err });
        return new Map<string, JevRating>();
      }
    }),
  );
  const merged = new Map<string, JevRating>();
  for (const m of results) for (const [k, v] of m) merged.set(k, v);
  return merged;
}
