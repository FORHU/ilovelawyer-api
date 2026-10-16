import { createHash } from "crypto";
import { CaseDocumentGrounding } from "./chatWonder";
import { TenantCode } from "../types/tenant-code";

export function chatWonderSessionKey(consultationId: string): string {
  return `chatwonder:session:${consultationId}`;
}

/** Marks a trial guest's seeded sample consultation (TrialSvc.seedSampleConsultation): the only
 * consultation whose earlier turns ChatSvc.trialSessionRecap hands to the model. */
export function trialSampleKey(consultationId: string): string {
  return `trial:sample:${consultationId}`;
}

/** Set once a Chat Wonder session has been given the consultation's earlier turns (see
 * ChatSvc.trialSessionRecap). Keyed by session, not consultation: a new session starts without them. */
export function chatWonderRecapKey(sessionId: string): string {
  return `chatwonder:recap:${sessionId}`;
}

export function messageHash(text: string): string {
  return createHash("md5").update(text.trim().toLowerCase()).digest("hex");
}

// TenantCode is part of the cache key so a UK request never gets served a title generated
// under the PH prompt (or vice versa) for the same message text.
export function titleCacheKey(userMessage: string, tenantCode: TenantCode): string {
  return `title:prompt:${tenantCode}:${messageHash(userMessage.slice(0, 500))}`;
}

/** Redis key for a cached chat-wonder reply.
 * Includes consultationId so two chats with the same prompt/docs don't share answers. Doesn't
 * need tenantCode added: a Consultation belongs to one Organization, whose tenantCode is
 * fixed, so consultationId alone already pins it. */
export function responseCacheKey(
  consultationId: string,
  userMessage: string,
  resolvedContext: string,
  groundingKey: string,
): string {
  return `chat:response:${messageHash(
    [consultationId, userMessage.trim().toLowerCase(), resolvedContext, groundingKey].join("\0"),
  )}`;
}

/** Compact fingerprint of which docs/chunks grounded this turn — part of responseCacheKey.
 * Built from the ranking result (doc ids + chunk ids), not stored separately in Redis. */
export function groundingCacheKey(grounding?: CaseDocumentGrounding): string {
  if (!grounding?.caseDocumentIds.length) return "";
  return [
    grounding.caseDocumentIds.slice().sort().join(","),
    (grounding.caseDocumentChunkIds ?? []).join(","),
  ].join("|");
}
