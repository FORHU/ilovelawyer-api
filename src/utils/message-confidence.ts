import { openField, sealField } from "./field-crypto";
import logger from "./logger";
import { parseConfidencePayload, type ConfidencePayload } from "./response-parser";

/** Confidence view (docs/plans/confidence-view-integration.md). Off unless
 * CONFIDENCE_VIEW_ENABLED=true — see .env.example. Read per call so a test can flip it. */
export function confidenceViewEnabled(): boolean {
  return process.env.CONFIDENCE_VIEW_ENABLED === "true";
}

export const CONFIDENCE_PAYLOAD = "MessageConfidence.payload";

/** The payload as stored: JSON, sealed like Message.content (its spans quote the answer verbatim,
 * so leaving them plain would undo FIELD_ENCRYPTION_ENABLED for that text). */
export function sealConfidencePayload(payload: ConfidencePayload): string {
  return sealField(JSON.stringify(payload), CONFIDENCE_PAYLOAD, true) as string;
}

/** The stored payload opened and re-validated, or null when it can't be opened or no longer
 * parses — the message itself still loads, it just shows no Confidence view. */
export function openConfidencePayload(stored: string | null | undefined): ConfidencePayload | null {
  if (!stored) return null;
  const opened = openField(stored, CONFIDENCE_PAYLOAD);
  if (opened === null) return null;
  try {
    return parseConfidencePayload(JSON.parse(opened)) ?? null;
  } catch (err) {
    logger.warn("Confidence payload could not be parsed; leaving it out", { err });
    return null;
  }
}

/** Points citation spans at the links as SAVED. rewriteLegalCitationLinks swaps chat-wonder's
 * external hrefs for Library hrefs (or strips unresolved links to plain text); a span whose link
 * was stripped is dropped, since there's no link left for it to style. Without a map (nothing was
 * rewritten), spans are kept as they are. */
export function remapConfidenceCitations(
  payload: ConfidencePayload,
  hrefMap: Map<string, string | null> | undefined,
): ConfidencePayload {
  if (!hrefMap || hrefMap.size === 0) return payload;
  const spans = payload.spans.flatMap((span) => {
    if (span.source !== "citation" || !span.ref) return [span];
    if (!hrefMap.has(span.ref)) return [span];
    const mapped = hrefMap.get(span.ref);
    return mapped ? [{ ...span, ref: mapped }] : [];
  });
  return { ...payload, spans };
}
