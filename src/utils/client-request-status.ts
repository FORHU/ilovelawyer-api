import type { ClaimOutcome, ClientRequestStatus } from "@prisma/client";

/**
 * The status a request shows its client, and admins. Several lawyers (phase 5): a request stays
 * ROUTED until the client picks a quote, so it shows QUOTED once any lawyer on it has quoted, and
 * CLAIMED once any has joined, as when one lawyer held a request. `claims` can be all of them: only
 * the open ones (no outcome) count.
 */
export function shownStatus(status: ClientRequestStatus, claims: { outcome: ClaimOutcome | null; quotedAt: Date | null }[]): ClientRequestStatus {
  if (status !== "ROUTED") return status;
  const open = claims.filter((c) => c.outcome === null);
  return open.some((c) => c.quotedAt) ? "QUOTED" : open.length ? "CLAIMED" : "ROUTED";
}
