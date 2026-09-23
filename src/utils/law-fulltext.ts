import * as cheerio from "cheerio";
import { extractText } from "./document-text-extraction";
import logger from "./logger";
import type { Law } from "@prisma/client";

const FETCH_TIMEOUT_MS = 20_000;
// Generous for a single decision — a cheap backstop against a bad/oversized URL, not a tuned limit.
const MAX_PDF_BYTES = 25 * 1024 * 1024;

/** sc.judiciary.gov.ph's WAF 403s a plain fetch with no User-Agent at all — confirmed by
 * reproducing the exact failure, same header law.controller.ts's `/pdf` proxy already sends. */
export const OUTBOUND_FETCH_HEADERS = {
  "user-agent": "Mozilla/5.0 (compatible; ilovelawyer/1.0; +https://ilovelawyer.com)",
};

/** Downloads and extracts a PDF's text, given the response already fetched for it. Shared by the
 * direct pdfUrl path and the "HTML page that just embeds a PDF" path below — both end up with a
 * PDF response to turn into text the same way. */
async function pdfResponseToText(res: Response, url: string): Promise<string | null> {
  let buffer: Buffer;
  try {
    const arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_PDF_BYTES) {
      logger.warn("Law full text: document PDF exceeded size cap", { url, size: arrayBuffer.byteLength });
      return null;
    }
    buffer = Buffer.from(arrayBuffer);
  } catch (err) {
    logger.warn("Law full text: failed to read document PDF body", { url, err });
    return null;
  }

  try {
    const text = await extractText(buffer, "application/pdf", url);
    return text.trim() || null;
  } catch (err) {
    logger.warn("Law full text: failed to parse document PDF", { url, err });
    return null;
  }
}

/** Fetches and extracts a PDF from a URL discovered mid-parse (the embedded-PDF case below) —
 * unlike the top-level fetch in fetchLawFullText, a non-PDF response here is just a bad guess at
 * the embed, not a genuinely unsupported source, so it's a quiet null rather than a warning. */
async function fetchPdfText(url: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: OUTBOUND_FETCH_HEADERS });
  } catch (err) {
    logger.warn("Law full text: failed to fetch embedded PDF", { url, err });
    return null;
  }
  if (!res.ok) return null;
  return pdfResponseToText(res, url);
}

/**
 * Plain text from an HTML document page. Two shapes are known:
 *  - LawPhil (republic-acts and most jurisprudence — see lawPhilRepublicActUrl /
 *    lawPhilUrlFromPath in juris-ph.ts): old-school table layout with no content-specific class,
 *    but the document body is reliably the page's first `<blockquote>`. `<cite>` is stripped
 *    first — LawPhil hides a copyright watermark inside one on every page — as are
 *    `<script>`/`<style>` (cheerio's `.text()` doesn't treat either specially and would
 *    otherwise include their raw source).
 *  - sc.judiciary.gov.ph (the remaining jurisprudence, when juris.ph's `source_url` points here
 *    instead of `source_pdf_url` directly): a WordPress page with no usable body text of its own
 *    — it's mostly nav/menu chrome — but it embeds the real decision PDF via a distinctive
 *    `pdfemb-viewer` link, which appears well before the footer's unrelated boilerplate PDFs
 *    (access-to-information, SALN forms) also present on every page of that site.
 * Falls back to the whole `<body>` text for a page matching neither template, which is noisy but
 * still better than nothing.
 */
async function htmlToPlainText(html: string): Promise<string | null> {
  const $ = cheerio.load(html);
  $("script, style, cite").remove();

  const blockquote = $("blockquote").first();
  if (blockquote.length > 0) {
    return normalizeWhitespace(blockquote.text()) || null;
  }

  const embeddedPdf = $("a.pdfemb-viewer[href]").first().attr("href");
  if (embeddedPdf) {
    return fetchPdfText(embeddedPdf);
  }

  return normalizeWhitespace($("body").text()) || null;
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Best-effort full text of a Law document, fetched from its cached pdfUrl/sourceUrl — juris.ph
 * exposes no full-text endpoint, so this is the only way to get past the `facts`/`disposition`
 * (jurisprudence) or `summary` (republic-acts) fields. Handles a direct PDF (most commonly
 * sc.judiciary.gov.ph), a LawPhil HTML page, and an sc.judiciary.gov.ph HTML page that only
 * embeds the real PDF (see htmlToPlainText). Used both to persist `Law.fullText` for the
 * document-detail view (LawSvc.getDocument) and, as a richer source than those summary fields,
 * for citation extraction (CitationExtractionSvc). Returns null on any failure (missing url,
 * network error, unsupported content type, oversized body, parse failure) so callers can fall
 * back to Law's summary fields instead of failing outright.
 */
export async function fetchLawFullText(law: Pick<Law, "pdfUrl" | "sourceUrl">): Promise<string | null> {
  const url = law.pdfUrl ?? law.sourceUrl;
  if (!url) return null;

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: OUTBOUND_FETCH_HEADERS });
  } catch (err) {
    logger.warn("Law full text: failed to fetch document", { url, err });
    return null;
  }

  if (!res.ok) {
    logger.warn("Law full text: document fetch returned non-OK status", { url, status: res.status });
    return null;
  }

  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const isPdf = contentType.includes("pdf") || url.toLowerCase().endsWith(".pdf");
  const isHtml = contentType.includes("html");

  if (isHtml) {
    try {
      // LawPhil and sc.judiciary.gov.ph both send no charset in their Content-Type header (so
      // `res.text()`'s UTF-8 default would mangle every accented/curly-quote/em-dash byte into a
      // replacement character) but declare windows-1252 in their own <meta> tag — decode against
      // that directly.
      const html = new TextDecoder("windows-1252").decode(await res.arrayBuffer());
      return await htmlToPlainText(html);
    } catch (err) {
      logger.warn("Law full text: failed to parse document HTML", { url, err });
      return null;
    }
  }

  if (!isPdf) {
    logger.warn("Law full text: document URL returned an unsupported content type", { url, contentType });
    return null;
  }

  return pdfResponseToText(res, url);
}
