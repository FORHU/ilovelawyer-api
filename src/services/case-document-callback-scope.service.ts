import { redis } from "../lib/redis";
import logger from "../utils/logger";

/**
 * Which case documents Chat Wonder may read back through GET /api/v1/case-document/*.
 *
 * Those routes are server-to-server: they are guarded by one shared API key and know nothing
 * about the user, organization or case they are being called for. A key alone is therefore
 * enough to read any document by id. This closes the worst of that without changing the
 * contract: every turn we hand Chat Wonder a list of case_document_ids, and we remember exactly
 * that list (in Redis, so any API instance can answer). The callback then refuses an id we did
 * not hand out recently, so a guessed id, or one an AI was tricked into requesting, returns
 * nothing.
 *
 * This is deliberately not tenant-level proof: the callback still cannot say which tenant's turn
 * it belongs to (that needs a per-turn signed token Chat Wonder sends back). It shuts the door on
 * ids no turn ever used.
 *
 * CASE_DOCUMENT_CALLBACK_SCOPE_MODE: "enforce" (default) refuses unknown ids; "warn" only logs
 * them (use while rolling out); "off" disables the check.
 */

export type CallbackScopeMode = "enforce" | "warn" | "off";

/** Long enough for a slow turn (generation, extras, retries) - the list is refreshed every turn. */
export const CALLBACK_SCOPE_TTL_S = 30 * 60;

const KEY_PREFIX = "casedoc:inflight:";

export function callbackScopeMode(): CallbackScopeMode {
  const v = (process.env.CASE_DOCUMENT_CALLBACK_SCOPE_MODE ?? "enforce").toLowerCase();
  return v === "warn" || v === "off" ? v : "enforce";
}

const keyFor = (documentId: string) => `${KEY_PREFIX}${documentId.toLowerCase()}`;

/** Remembers the documents handed to Chat Wonder for a turn. Never throws: a Redis problem must
 * not stop a chat turn (the callback side then fails open, see isDocumentInScope). */
export async function registerTurnDocuments(documentIds: string[]): Promise<void> {
  try {
    const unique = [...new Set(documentIds.filter(Boolean))];
    if (!unique.length) return;
    await redis.markMany(unique.map(keyFor), CALLBACK_SCOPE_TTL_S);
  } catch (err) {
    logger.warn("Case document callback scope: could not register turn documents", { err });
  }
}

/** true = allowed, false = refuse. Redis being unreachable allows (and warns): an outage of the
 * cache must not become an outage of chat. */
export async function isDocumentInScope(documentId: string): Promise<boolean> {
  const mode = callbackScopeMode();
  if (mode === "off") return true;

  const present = await redis.exists(keyFor(documentId));
  if (present === null) {
    logger.warn("Case document callback scope: Redis unavailable, allowing without the scope check", { documentId });
    return true;
  }
  if (present) return true;

  logger.warn("Case document callback scope: id was not handed to Chat Wonder for any recent turn", {
    documentId,
    mode,
  });
  return mode === "warn";
}

/** Drops the ids that are not in scope from a list (used by the by-case / by-consultation list). */
export async function filterDocumentsInScope<T>(items: T[], idOf: (item: T) => string): Promise<T[]> {
  const kept: T[] = [];
  for (const item of items) {
    if (await isDocumentInScope(idOf(item))) kept.push(item);
  }
  return kept;
}
