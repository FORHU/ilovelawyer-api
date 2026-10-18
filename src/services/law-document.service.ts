import { createHash } from "crypto";
import { promisify } from "util";
import { gunzip as gunzipCb, gzip as gzipCb } from "zlib";
import type { Law, LawDocumentCopy } from "@prisma/client";
import LawDocumentCopyRepo, { type LawDocumentCopyMeta } from "../repositories/law-document-copy.repository";
import { legislationUrlParts } from "../legal/law-source/uk/uk-law-mappers";
import { UK_EU_LEGISLATION_TYPES } from "../legal/law-source/uk/uk-law-vocab";
import { UK_LEGISLATION_BASE_URL } from "../config";
import { OUTBOUND_FETCH_HEADERS } from "../utils/law-fulltext";
import logger from "../utils/logger";

// ── Our own copies of UK legislation ─────────────────────────────────────────
// The Library's document viewer (LawCtrl.pdf) re-serves a law's official document from our origin.
// For UK legislation it also keeps legislation.gov.uk's HTML in Postgres (LawDocumentCopy.content,
// gzip-compressed — a large Act's 2–5 MB of HTML is 0.3–0.5 MB), so a viewed Act opens from our copy
// and still opens when legislation.gov.uk is down or its AWS WAF refuses us:
//
//   - a copy younger than COPY_TTL_MS is served as is, without asking legislation.gov.uk;
//   - an older one is refetched, and stands in only if legislation.gov.uk can't be reached;
//   - UK legislation is only ever legislation.gov.uk's HTML; judgments' PDFs are served live and
//     never saved.

/** How long a saved copy is served before legislation.gov.uk is asked again. */
export const COPY_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function isFresh(copy: Pick<LawDocumentCopy, "checkedAt">, now = Date.now()): boolean {
  return now - copy.checkedAt.getTime() < COPY_TTL_MS;
}

/** A whole Act's HTML can be large; past this we serve it but don't keep it. */
export const MAX_COPY_BYTES = 50 * 1024 * 1024;

const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);

export interface LawDocumentBody {
  body: Buffer;
  /** "html" is legislation.gov.uk's raw rendition — the caller makes it frameable. */
  format: "pdf" | "html";
  /** Where the bytes came from upstream. */
  sourceUrl: string;
  /** Set when the bytes are our saved copy (always HTML) rather than a live fetch. `stale` means the
   * copy is past its TTL and is being served only because legislation.gov.uk could not be reached. */
  copy?: { checkedAt: Date; stale: boolean };
}

function contentTypeOf(res: globalThis.Response): string {
  return (res.headers.get("content-type") ?? "").toLowerCase();
}

/** One upstream document fetch: the response when it is a 200, otherwise null (logged).
 * Strictly 200 — an AWS WAF challenge is a `202` text/html with an empty body, which a plain `res.ok`
 * would let through as if it were the document. */
async function fetchUpstream(url: string, accept: string, lawId: string): Promise<globalThis.Response | null> {
  let upstreamRes: globalThis.Response;
  try {
    upstreamRes = await fetch(url, {
      signal: AbortSignal.timeout(20_000),
      headers: { ...OUTBOUND_FETCH_HEADERS, accept },
    });
  } catch (err) {
    logger.warn("Law PDF proxy: upstream fetch failed", { lawId, upstream: url, err });
    return null;
  }
  const wafAction = upstreamRes.headers.get("x-amzn-waf-action");
  if (upstreamRes.status !== 200 || wafAction) {
    logger.warn("Law PDF proxy: upstream refused the request", {
      lawId,
      upstream: url,
      status: upstreamRes.status,
      contentType: contentTypeOf(upstreamRes),
      wafAction,
    });
    return null;
  }
  return upstreamRes;
}

/** The part key a copy is stored under: "" for the whole document, "section/29" for one section. */
export function copyPart(section: string | null): string {
  return section ? `section/${section}` : "";
}

export default class LawDocumentSvc {
  /** The law's official document for the viewer, or null when there is none to serve (the caller
   * 502s). `section` is pre-validated by the caller and only applies to UK legislation. */
  static async get(law: Law, section: string | null): Promise<LawDocumentBody | null> {
    // Only UK legislation is copied; everything else is always fetched live.
    if (!legislationUrlParts(law.jurisUrl)) return LawDocumentSvc.fetchLive(law, section);

    const part = copyPart(section);
    const saved = await LawDocumentCopyRepo.findLatest(law.id, part);

    if (saved && isFresh(saved)) {
      const copy = await LawDocumentSvc.readCopy(saved, false);
      if (copy) return copy;
    }

    const live = await LawDocumentSvc.fetchLive(law, section);
    if (live) {
      if (live.format === "html") {
        void LawDocumentSvc.save(law.id, part, live, saved).catch((err) =>
          logger.warn("Law document copy: save failed", { lawId: law.id, part, err }),
        );
      }
      return live;
    }

    if (saved) return LawDocumentSvc.readCopy(saved, !isFresh(saved));
    return null;
  }

  /** The live fetch. UK legislation is always legislation.gov.uk's HTML rendition (`data.html`) —
   * its PDF is never asked for (its AWS WAF refuses server-side `data.pdf` requests anyway). Every
   * other document (PH jurisprudence, PH republic-acts, UK case law) is its PDF, from pdfUrl. */
  static async fetchLive(law: Law, section: string | null): Promise<LawDocumentBody | null> {
    const parts = legislationUrlParts(law.jurisUrl);
    if (parts) {
      // Retained EU law numbers its provisions as articles: "art 6 UK GDPR" is …/eur/2016/679/article/6.
      const provision = (UK_EU_LEGISLATION_TYPES as readonly string[]).includes(parts.type) ? "article" : "section";
      const htmlUrl = `${UK_LEGISLATION_BASE_URL}/${parts.type}/${parts.year}/${parts.number}${section ? `/${provision}/${section}` : ""}/data.html`;
      // legislation.gov.uk answers a bare `Accept: text/html` on data.html with 406 — it needs the `*/*`.
      const htmlRes = await fetchUpstream(htmlUrl, "text/html,*/*", law.id);
      if (htmlRes && contentTypeOf(htmlRes).includes("html")) {
        return { body: Buffer.from(await htmlRes.arrayBuffer()), format: "html", sourceUrl: htmlUrl };
      }
      return null;
    }

    if (!law.pdfUrl) return null;
    const pdfRes = await fetchUpstream(law.pdfUrl, "application/pdf,*/*", law.id);
    if (pdfRes && contentTypeOf(pdfRes).includes("pdf")) {
      return { body: Buffer.from(await pdfRes.arrayBuffer()), format: "pdf", sourceUrl: law.pdfUrl };
    }
    if (pdfRes) {
      logger.warn("Law PDF proxy: upstream returned non-PDF response", { lawId: law.id, upstream: law.pdfUrl, contentType: contentTypeOf(pdfRes) });
    }
    return null;
  }

  /** Keeps legislation.gov.uk's HTML `doc` as the latest copy of `part`. Same bytes as `previous` only
   * moves its checkedAt; different bytes add a row with the HTML gzip-compressed. Nothing is
   * overwritten. A PDF is never kept. */
  static async save(lawId: string, part: string, doc: LawDocumentBody, previous: Pick<LawDocumentCopy, "id" | "sha256"> | null): Promise<void> {
    if (doc.format !== "html") return;
    if (doc.body.length > MAX_COPY_BYTES) {
      logger.warn("Law document copy: too large to keep", { lawId, part, bytes: doc.body.length });
      return;
    }
    const now = new Date();
    const sha256 = createHash("sha256").update(doc.body).digest("hex");
    if (previous && previous.sha256 === sha256) {
      await LawDocumentCopyRepo.markChecked(previous.id, now);
      return;
    }
    await LawDocumentCopyRepo.create({
      lawId,
      part,
      sha256,
      sourceUrl: doc.sourceUrl,
      content: await gzip(doc.body),
      bytes: doc.body.length,
      fetchedAt: now,
      checkedAt: now,
    });
  }

  /** A saved copy's HTML, or null (logged) when it can't be read back. */
  static async readCopy(copy: LawDocumentCopyMeta, stale: boolean): Promise<LawDocumentBody | null> {
    try {
      const content = await LawDocumentCopyRepo.findContent(copy.id);
      if (!content) return null;
      const body = await gunzip(content);
      return { body, format: "html", sourceUrl: copy.sourceUrl, copy: { checkedAt: copy.checkedAt, stale } };
    } catch (err) {
      logger.warn("Law document copy: read failed", { lawId: copy.lawId, copyId: copy.id, err });
      return null;
    }
  }
}
