import { createHash } from "crypto";
import { promisify } from "util";
import { gunzip as gunzipCb, gzip as gzipCb } from "zlib";
import type { Law, LawDocumentCopy } from "@prisma/client";
import LawDocumentCopyRepo, { type LawDocumentCopyMeta } from "../repositories/law-document-copy.repository";
import { legislationUrlParts } from "../legal/law-source/uk/uk-law-mappers";
import { UK_LEGISLATION_BASE_URL } from "../config";
import { OUTBOUND_FETCH_HEADERS } from "../utils/law-fulltext";
import logger from "../utils/logger";
import type { LawDocumentCopyInfo } from "./law.service";

// ── Our own copies of UK legislation ─────────────────────────────────────────
// The Library's document viewer (LawCtrl.pdf) re-serves a law's official document from our origin.
// For UK legislation it can also keep a copy in Postgres (LawDocumentCopy.content, gzip-compressed —
// a large Act's 2–5 MB of HTML is 0.3–0.5 MB), so a viewed Act still opens when legislation.gov.uk is
// down or its AWS WAF refuses us. UK_LEGISLATION_COPIES picks how far:
//
//   off    (default) fetch live every time, keep nothing — the behaviour before copies existed
//   store  fetch live every time, and save a copy (at most once per TTL); never serve the copy
//   serve  serve the saved copy while it is fresh; refetch once it is older than the TTL; serve the
//          last copy when legislation.gov.uk can't be reached
//
// "serve" redistributes Crown copyright text from our own storage. Keep it off in production until
// the Open Government Licence conditions have been reviewed. Read on every call, like
// UK_LEGISLATION_DIRECT_FALLBACK, so tests and a restart-free env change both take effect.

export type LawCopiesMode = "off" | "store" | "serve";

export function copiesMode(): LawCopiesMode {
  const raw = (process.env.UK_LEGISLATION_COPIES ?? "").trim().toLowerCase();
  return raw === "store" || raw === "serve" ? raw : "off";
}

const DEFAULT_TTL_DAYS = 90;

export function copyTtlMs(): number {
  const days = Number(process.env.UK_LEGISLATION_COPY_TTL_DAYS);
  return (Number.isFinite(days) && days > 0 ? days : DEFAULT_TTL_DAYS) * 24 * 60 * 60 * 1000;
}

function isFresh(copy: Pick<LawDocumentCopy, "checkedAt">, now = Date.now()): boolean {
  return now - copy.checkedAt.getTime() < copyTtlMs();
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
  /** Set when the bytes are our saved copy rather than a live fetch. `stale` means the copy is past
   * its TTL and is being served only because legislation.gov.uk could not be reached. */
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
    const isUkLegislation = !!legislationUrlParts(law.jurisUrl);
    const mode = isUkLegislation ? copiesMode() : "off";
    const part = copyPart(section);
    const saved = mode === "off" ? null : await LawDocumentCopyRepo.findLatest(law.id, part);

    if (mode === "serve" && saved && isFresh(saved)) {
      const copy = await LawDocumentSvc.readCopy(saved, false);
      if (copy) return copy;
    }

    const live = await LawDocumentSvc.fetchLive(law, section);
    if (live) {
      // "store" saves at most once per TTL, so a popular Act isn't rewritten on every view.
      if (mode !== "off" && !(saved && isFresh(saved))) {
        void LawDocumentSvc.save(law.id, part, live, saved).catch((err) =>
          logger.warn("Law document copy: save failed", { lawId: law.id, part, err }),
        );
      }
      return live;
    }

    if (mode === "serve" && saved) return LawDocumentSvc.readCopy(saved, !isFresh(saved));
    return null;
  }

  /** The live fetch the proxy has always done. UK legislation stores no pdfUrl (see
   * legislationHitToCreateInput) — its PDF only exists at a derived legislation.gov.uk path; every
   * other document (PH jurisprudence, PH republic-acts, UK case law) has its direct PDF url in pdfUrl. */
  static async fetchLive(law: Law, section: string | null): Promise<LawDocumentBody | null> {
    const parts = legislationUrlParts(law.jurisUrl);
    const ukLegislationPath = parts
      ? `${UK_LEGISLATION_BASE_URL}/${parts.type}/${parts.year}/${parts.number}${section ? `/section/${section}` : ""}`
      : null;
    const pdfUrl = ukLegislationPath ? `${ukLegislationPath}/data.pdf` : law.pdfUrl;
    if (!pdfUrl) return null;

    const pdfRes = await fetchUpstream(pdfUrl, "application/pdf,*/*", law.id);
    if (pdfRes && contentTypeOf(pdfRes).includes("pdf")) {
      return { body: Buffer.from(await pdfRes.arrayBuffer()), format: "pdf", sourceUrl: pdfUrl };
    }
    if (pdfRes) {
      logger.warn("Law PDF proxy: upstream returned non-PDF response", { lawId: law.id, upstream: pdfUrl, contentType: contentTypeOf(pdfRes) });
    }

    // legislation.gov.uk's AWS WAF answers every server-side `data.pdf` request with a JS
    // challenge (202, `x-amzn-waf-action: challenge`, empty body) — whatever the User-Agent —
    // while still serving the same Act's `data.html` rendition. Frame that instead of a blank.
    if (ukLegislationPath) {
      const htmlUrl = `${ukLegislationPath}/data.html`;
      // legislation.gov.uk answers a bare `Accept: text/html` on data.html with 406 — it needs the `*/*`.
      const htmlRes = await fetchUpstream(htmlUrl, "text/html,*/*", law.id);
      if (htmlRes && contentTypeOf(htmlRes).includes("html")) {
        return { body: Buffer.from(await htmlRes.arrayBuffer()), format: "html", sourceUrl: htmlUrl };
      }
    }
    return null;
  }

  /** Keeps `doc` as the latest copy of `part`. Same bytes as `previous` only moves its checkedAt;
   * different bytes add a row with the document gzip-compressed. Nothing is overwritten. */
  static async save(
    lawId: string,
    part: string,
    doc: LawDocumentBody,
    previous: Pick<LawDocumentCopy, "id" | "sha256" | "format"> | null,
  ): Promise<void> {
    if (doc.body.length > MAX_COPY_BYTES) {
      logger.warn("Law document copy: too large to keep", { lawId, part, bytes: doc.body.length });
      return;
    }
    const now = new Date();
    const sha256 = createHash("sha256").update(doc.body).digest("hex");
    if (previous && previous.sha256 === sha256 && previous.format === doc.format) {
      await LawDocumentCopyRepo.markChecked(previous.id, now);
      return;
    }
    await LawDocumentCopyRepo.create({
      lawId,
      part,
      format: doc.format,
      sha256,
      sourceUrl: doc.sourceUrl,
      content: await gzip(doc.body),
      bytes: doc.body.length,
      fetchedAt: now,
      checkedAt: now,
    });
  }

  /** A saved copy's bytes, or null (logged) when they can't be read back. */
  static async readCopy(copy: LawDocumentCopyMeta, stale: boolean): Promise<LawDocumentBody | null> {
    if (copy.format !== "pdf" && copy.format !== "html") return null;
    try {
      const content = await LawDocumentCopyRepo.findContent(copy.id);
      if (!content) return null;
      const body = await gunzip(content);
      return { body, format: copy.format, sourceUrl: copy.sourceUrl, copy: { checkedAt: copy.checkedAt, stale } };
    } catch (err) {
      logger.warn("Law document copy: read failed", { lawId: copy.lawId, copyId: copy.id, err });
      return null;
    }
  }

  /** What the detail page needs to label the viewer: the latest copy of each part, but only in
   * "serve" mode — in "off" and "store" the viewer always shows the live document. */
  static async copiesFor(law: Pick<Law, "id" | "jurisUrl">): Promise<LawDocumentCopyInfo[]> {
    if (copiesMode() !== "serve" || !legislationUrlParts(law.jurisUrl)) return [];
    const now = Date.now();
    const rows = await LawDocumentCopyRepo.listLatestByLaw(law.id);
    return rows.map((r) => ({ part: r.part, checked_at: r.checkedAt.toISOString(), fresh: isFresh(r, now) }));
  }
}
