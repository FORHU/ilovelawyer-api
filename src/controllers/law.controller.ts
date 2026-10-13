import { Request, Response } from "express";
import LawRepo from "../repositories/law.repository";
import CitationEdgeRepo from "../repositories/citation-edge.repository";
import CitationExtractionQueue from "../queues/citation-extraction.queue";
import UkCitationNetworkSvc from "../services/uk-citation-network.service";
import AiGenerationLockSvc from "../services/ai-generation-lock.service";
import LawDocumentSvc from "../services/law-document.service";
import HttpError from "../utils/http-error";
import { getTenantContext } from "../utils/tenant-context";
import { assertCitationsAvailable } from "../utils/law.utils";
import { getLawSourceProvider } from "../legal/law-source/law-source.registry";
import { legislationUrlParts } from "../legal/law-source/uk/uk-law-mappers";
import { UK_LEGISLATION_BASE_URL } from "../config";
import { lawSearchSchema, lawDocumentSchema, lawBrowseSchema } from "../validation/law.validation";
import { frameableLegislationHtml } from "../utils/uk-legislation-direct";

export default class LawCtrl {
  /**
   * GET /api/law/search — local-first search for the Library tab. The `LawSourceProvider` for
   * the caller's tenantCode (PH → juris.ph, UK → UK Legal MCP) checks stored `Law` rows first,
   * calls upstream on a miss, and writes results through. An unmapped tenantCode gets a 501
   * "coming soon" from the registry rather than another jurisdiction's data.
   */
  static async search(req: Request, res: Response) {
    const provider = getLawSourceProvider(getTenantContext(req).tenantCode);

    const { error, value } = lawSearchSchema(provider).validate(req.query, { convert: true });
    if (error) throw new HttpError(error.message, 400);

    const result = await provider.search({
      category: provider.parseCategory(value.category),
      q: value.q,
      limit: value.limit,
      courts: value.court,
      cursor: value.cursor,
    });
    return res.status(200).json(result);
  }

  /**
   * GET /api/law/browse — faceted browse (no free-text query), 20 per page with an opaque
   * `cursor` for "load more". Facets are tenant-specific: PH → `caseType` (jurisprudence only)
   * + `topics` csv; UK → `court` (case law only). Facets that don't apply to the resolved
   * provider/category are ignored by the provider.
   */
  static async browse(req: Request, res: Response) {
    const provider = getLawSourceProvider(getTenantContext(req).tenantCode);

    const { error, value } = lawBrowseSchema(provider).validate(req.query, { convert: true });
    if (error) throw new HttpError(error.message, 400);

    const result = await provider.browse({
      category: provider.parseCategory(value.category),
      facets: {
        caseType: value.caseType,
        topics: value.topics,
        courts: value.court,
        year: value.year,
      },
      cursor: value.cursor,
      limit: value.limit,
    });
    return res.status(200).json(result);
  }

  /**
   * GET /api/law/document — one document by id, for the detail page. Local-first with detail:
   * a stored row that already has its full detail is served from the DB; otherwise the
   * provider's upstream fills it in and stores it. `id` is the juris source id for PH and our
   * `Law.id` uuid for UK.
   */
  static async getDocument(req: Request, res: Response) {
    const provider = getLawSourceProvider(getTenantContext(req).tenantCode);

    const { error, value } = lawDocumentSchema(provider).validate(req.query, { convert: true });
    if (error) throw new HttpError(error.message, 400);

    const result = await provider.getDocument({
      category: provider.parseCategory(value.category),
      id: value.id,
    });
    return res.status(200).json(result);
  }

  /**
   * GET /api/law/preview — the chat citation hover card: title, reference, year, court and a
   * short snippet. Same query as /document (`id` is the juris source id for PH, `Law.id` for UK),
   * but DB-only and small — see LawSourceProvider.getPreview. Law rows don't change after
   * they're stored, so the browser may cache it for an hour.
   */
  static async getPreview(req: Request, res: Response) {
    const provider = getLawSourceProvider(getTenantContext(req).tenantCode);

    const { error, value } = lawDocumentSchema(provider).validate(req.query, { convert: true });
    if (error) throw new HttpError(error.message, 400);

    const result = await provider.getPreview({
      category: provider.parseCategory(value.category),
      id: value.id,
    });
    // No snippet yet can mean a first-time detail fill is still finishing in the background (see
    // UkLawSourceProvider.getPreview) — don't let the browser pin that empty answer for an hour.
    res.setHeader("Cache-Control", result.snippet ? "private, max-age=3600" : "no-store");
    return res.status(200).json(result);
  }

  /**
   * GET /api/law/:lawId/pdf — same-origin proxy for a stored law's official PDF (see law.route.ts).
   * Several upstreams refuse framing outright (legislation.gov.uk, the TNA judgment site) and,
   * per user report, so does juris.ph's own PDF host for PH jurisprudence/republic-acts — a
   * direct top-level navigation (our "open in a new tab" link) renders fine, but the same URL as
   * an <iframe src> comes back blank because of X-Frame-Options / CSP frame-ancestors. Re-serving
   * the bytes from our own origin sidesteps that for every source, not just UK's.
   * UK legislation falls back to legislation.gov.uk's HTML rendition when its PDF is refused, so
   * this route can answer with text/html as well as a PDF, and can be served from our own S3 copy
   * (see LawDocumentSvc / UK_LEGISLATION_COPIES).
   * Returns 502 when the upstream is unreachable or answers with neither, and no copy can stand
   * in — the client falls back to a "View source" link.
   */
  static async pdf(req: Request, res: Response) {
    const law = await LawRepo.findById(req.params.lawId);
    if (!law) throw new HttpError("Law not found", 404);
    // UK legislation's document lives at a derived legislation.gov.uk path; everything else needs a pdfUrl.
    if (!legislationUrlParts(law.jurisUrl) && !law.pdfUrl) throw new HttpError("No PDF available for this document", 404);

    // `?section=49` (UK legislation only) serves just that section — legislation.gov.uk publishes
    // one at `/section/<n>/data.pdf` — so a chat citation to "s 49" opens on s 49, not the Act's
    // first page. Strictly "<digits><letters>" so it can't steer the upstream path anywhere else.
    const section = typeof req.query.section === "string" && /^[0-9]+[A-Z]*$/i.test(req.query.section) ? req.query.section : null;

    // Live from upstream, or (UK legislation, UK_LEGISLATION_COPIES=serve) our saved S3 copy.
    const doc = await LawDocumentSvc.get(law, section);
    if (!doc) throw new HttpError("The official document source is unavailable right now", 502);

    // helmet() set these on the way in — drop them so the frontend (a different origin) can
    // embed the document in an <iframe>. Safe here: the body is public primary law, nothing
    // an attacker gains by framing.
    res.removeHeader("X-Frame-Options");
    res.removeHeader("Content-Security-Policy");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    // A stale copy stands in only while legislation.gov.uk is unreachable — don't let the browser keep it.
    res.setHeader("Cache-Control", doc.copy?.stale ? "no-store" : "public, max-age=86400");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (doc.copy) res.setHeader("X-Law-Copy-Checked-At", doc.copy.checkedAt.toISOString());

    if (doc.format === "pdf") {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", "inline");
      return res.send(doc.body);
    }

    // Live or saved, the HTML is legislation.gov.uk's raw rendition — made frameable here, on the way out.
    const html = frameableLegislationHtml(doc.body.toString("utf8"), UK_LEGISLATION_BASE_URL);
    const legislationOrigin = new URL(UK_LEGISLATION_BASE_URL).origin;
    // Third-party HTML on our API origin: `sandbox` (no allow-scripts, no allow-same-origin)
    // gives it an opaque origin with nothing able to run; popups are allowed so its links
    // (all `target="_blank"`) still open legislation.gov.uk in a new tab.
    res.setHeader(
      "Content-Security-Policy",
      `sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'; style-src 'unsafe-inline' ${legislationOrigin}; img-src ${legislationOrigin} data:; font-src ${legislationOrigin}`,
    );
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(html);
  }

  /**
   * POST /api/law/:lawId/citations/expand — enqueues citation extraction for this decision
   * (a PDF-fetch chained with an LLM call, plausibly 10-30s+, so this is fire-and-forget +
   * poll rather than a blocking request — see CitationExtractionQueue / getCitations below).
   * Returns cached edges immediately, with no enqueue, if extraction already ran.
   */
  static async expandCitations(req: Request, res: Response) {
    const tenantCode = assertCitationsAvailable(req);
    const law = await LawRepo.findById(req.params.lawId);
    if (!law) throw new HttpError("Law not found", 404);

    if (law.citationsExtractedAt) {
      const edges = await CitationEdgeRepo.listByFromLaw(law.id);
      return res.status(200).json({ status: "DONE", edges });
    }

    // UK: citations_network is a real, structured answer from the MCP, not an LLM inference —
    // ~15 lightweight HTTP calls, fast enough to run inline. PH: PDF-fetch + LLM call,
    // plausibly 10-30s+, so it stays fire-and-forget + poll via the queue.
    if (tenantCode === "UK") {
      const edges = await AiGenerationLockSvc.run(law.id, "citationExpand", () => UkCitationNetworkSvc.expand(law.id));
      return res.status(200).json({ status: "DONE", edges });
    }

    // begin (not run) — the actual work happens later in the queue worker, which calls finish
    // when it completes (citation-extraction.queue.ts). This is what stops two clicks (or a
    // refresh + a re-click) before the first job finishes from enqueueing the same lawId twice.
    await AiGenerationLockSvc.begin(law.id, "citationExpand");
    CitationExtractionQueue.enqueue(law.id);
    return res.status(202).json({ status: "IN_PROGRESS", edges: [] });
  }

  /** GET /api/law/:lawId/citations — poll endpoint for the job kicked off by expandCitations.
   * Only meaningful after an expand call; polling a decision that was never expanded reads as
   * IN_PROGRESS even though nothing is running — the frontend's poll flow always calls expand
   * first, so this doesn't arise in practice. */
  static async getCitations(req: Request, res: Response) {
    assertCitationsAvailable(req);
    const law = await LawRepo.findById(req.params.lawId);
    if (!law) throw new HttpError("Law not found", 404);

    const edges = await CitationEdgeRepo.listByFromLaw(law.id);
    return res.status(200).json({ status: law.citationsExtractedAt ? "DONE" : "IN_PROGRESS", edges });
  }
}
