import { Request, Response } from "express";
import LawRepo from "../repositories/law.repository";
import CitationEdgeRepo from "../repositories/citation-edge.repository";
import CitationExtractionQueue from "../queues/citation-extraction.queue";
import UkCitationNetworkSvc from "../services/uk-citation-network.service";
import AiGenerationLockSvc from "../services/ai-generation-lock.service";
import HttpError from "../utils/http-error";
import { getTenantContext } from "../utils/tenant-context";
import { assertCitationsAvailable } from "../utils/law.utils";
import { getLawSourceProvider } from "../legal/law-source/law-source.registry";
import { legislationUrlParts } from "../legal/law-source/uk/uk-law-mappers";
import { UK_LEGISLATION_BASE_URL } from "../config";
import { lawSearchSchema, lawDocumentSchema, lawBrowseSchema } from "../validation/law.validation";

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
        court: value.court,
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
   * GET /api/law/:lawId/pdf — same-origin proxy for a stored law's official PDF (see law.route.ts).
   * legislation.gov.uk and the TNA judgment site both refuse framing (X-Frame-Options: DENY), so
   * the browser can't embed those URLs directly; this streams the bytes back from our origin.
   * Returns 502 when the upstream is unreachable or answers with anything other than a PDF (e.g.
   * legislation.gov.uk's AWS-WAF challenge page) — the client falls back to a "View source" link.
   */
  static async pdf(req: Request, res: Response) {
    const law = await LawRepo.findById(req.params.lawId);
    if (!law) throw new HttpError("Law not found", 404);

    let upstream: string | null;
    if (law.category === "REPUBLIC_ACT") {
      const parts = legislationUrlParts(law.jurisUrl);
      upstream = parts
        ? `${UK_LEGISLATION_BASE_URL}/${parts.type}/${parts.year}/${parts.number}/data.pdf`
        : null;
    } else {
      upstream = law.pdfUrl ?? `${law.jurisUrl.replace(/\/+$/, "")}/data.pdf`;
    }
    if (!upstream) throw new HttpError("No PDF available for this document", 404);

    let upstreamRes: globalThis.Response;
    try {
      upstreamRes = await fetch(upstream, {
        signal: AbortSignal.timeout(20_000),
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; ilovelawyer/1.0; +https://ilovelawyer.com)",
          accept: "application/pdf,*/*",
        },
      });
    } catch {
      throw new HttpError("The official document source is unavailable right now", 502);
    }

    const contentType = (upstreamRes.headers.get("content-type") ?? "").toLowerCase();
    if (!upstreamRes.ok || !contentType.includes("pdf")) {
      throw new HttpError("The official document source is unavailable right now", 502);
    }

    const body = Buffer.from(await upstreamRes.arrayBuffer());
    // helmet() set these on the way in — drop them so the frontend (a different origin) can
    // embed this PDF in an <iframe>. Safe here: the body is a public primary-law PDF, nothing
    // an attacker gains by framing.
    res.removeHeader("X-Frame-Options");
    res.removeHeader("Content-Security-Policy");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.send(body);
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
