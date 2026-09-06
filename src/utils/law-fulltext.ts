import { extractText } from "./document-text-extraction";
import logger from "./logger";
import type { Law } from "@prisma/client";

const FETCH_TIMEOUT_MS = 20_000;
// Generous for a single decision — a cheap backstop against a bad/oversized URL, not a tuned limit.
const MAX_PDF_BYTES = 25 * 1024 * 1024;

/**
 * Best-effort full text of a jurisprudence decision, fetched from its cached pdfUrl — juris.ph
 * exposes no full-text endpoint, so this is the only way to get past `facts`/`disposition`
 * summaries for citation extraction (see CitationExtractionSvc). Returns null on any failure
 * (missing url, network error, non-PDF response, oversized body, parse failure) so the caller
 * can fall back to Law's summary fields instead of failing extraction outright.
 */
export async function fetchLawFullText(law: Pick<Law, "pdfUrl" | "sourceUrl">): Promise<string | null> {
  const url = law.pdfUrl ?? law.sourceUrl;
  if (!url) return null;

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    logger.warn("Citation extraction: failed to fetch decision PDF", { url, err });
    return null;
  }

  if (!res.ok) {
    logger.warn("Citation extraction: decision PDF fetch returned non-OK status", { url, status: res.status });
    return null;
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("pdf") && !url.toLowerCase().endsWith(".pdf")) {
    logger.warn("Citation extraction: decision URL did not return a PDF", { url, contentType });
    return null;
  }

  let buffer: Buffer;
  try {
    const arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_PDF_BYTES) {
      logger.warn("Citation extraction: decision PDF exceeded size cap", { url, size: arrayBuffer.byteLength });
      return null;
    }
    buffer = Buffer.from(arrayBuffer);
  } catch (err) {
    logger.warn("Citation extraction: failed to read decision PDF body", { url, err });
    return null;
  }

  try {
    const text = await extractText(buffer, "application/pdf", url);
    return text.trim() || null;
  } catch (err) {
    logger.warn("Citation extraction: failed to parse decision PDF", { url, err });
    return null;
  }
}
