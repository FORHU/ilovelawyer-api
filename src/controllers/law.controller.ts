import { Request, Response } from "express";
import LawSvc, { parseLawCategory } from "../services/law.service";
import LawRepo from "../repositories/law.repository";
import CitationEdgeRepo from "../repositories/citation-edge.repository";
import CitationExtractionQueue from "../queues/citation-extraction.queue";
import UkCitationNetworkSvc from "../services/uk-citation-network.service";
import AiGenerationLockSvc from "../services/ai-generation-lock.service";
import HttpError from "../utils/http-error";
import { getTenantContext } from "../utils/tenant-context";
import { assertCitationsAvailable } from "../utils/law.utils";
import { lawSearchSchema, lawDocumentSchema, lawBrowseSchema } from "../validation/law.validation";

export default class LawCtrl {
  /**
   * GET /api/law/search — the app-facing entry point to the same local-first search the
   * admin panel uses (LawSvc.search: stored rows first, juris.ph on a miss, write-through).
   * The admin route is ADMIN-only; this one is any authenticated org member.
   *
   * juris.ph only covers Philippine law, so this is PH-tenant only: every other tenantCode
   * (UK today, anything unmapped) gets a 501 "coming soon" rather than PH data. The frontend
   * gates the UI the same way (config/tenant-codes) and normally never calls this for a
   * non-PH org — the check here is defense-in-depth, matching legal-knowledge.registry.ts.
   */
  static async search(req: Request, res: Response) {
    const { tenantCode } = getTenantContext(req);
    if (tenantCode !== "PH") {
      throw new HttpError("Philippine law search is not available for this jurisdiction — coming soon", 501);
    }

    const { error, value } = lawSearchSchema.validate(req.query, { convert: true });
    if (error) throw new HttpError(error.message, 400);

    const result = await LawSvc.search({
      category: parseLawCategory(value.category),
      q: value.q,
      limit: value.limit,
    });
    return res.status(200).json(result);
  }

  /**
   * GET /api/law/browse — facet browse (no free-text query) over juris.ph, 20 per page with an
   * opaque `cursor` for "load more". Same PH-tenant-only rule as search. `caseType` applies to
   * jurisprudence only; `topics` is a csv of the juris.ph topic vocabulary.
   */
  static async browse(req: Request, res: Response) {
    const { tenantCode } = getTenantContext(req);
    if (tenantCode !== "PH") {
      throw new HttpError("Philippine law browse is not available for this jurisdiction — coming soon", 501);
    }

    const { error, value } = lawBrowseSchema.validate(req.query, { convert: true });
    if (error) throw new HttpError(error.message, 400);

    const result = await LawSvc.browse({
      category: parseLawCategory(value.category),
      caseType: value.category === "jurisprudence" ? value.caseType : undefined,
      topics: value.topics,
      year: value.year,
      cursor: value.cursor,
      limit: value.limit,
    });
    return res.status(200).json(result);
  }

  /**
   * GET /api/law/document — one document by its juris id, for the detail page. Local-first
   * with detail (LawSvc.getDocument): a stored row that already has its full detail is served
   * from the DB; otherwise juris.ph's retrieve API fills it in and stores it. PH-tenant only.
   */
  static async getDocument(req: Request, res: Response) {
    const { tenantCode } = getTenantContext(req);
    if (tenantCode !== "PH") {
      throw new HttpError("Philippine law documents are not available for this jurisdiction — coming soon", 501);
    }

    const { error, value } = lawDocumentSchema.validate(req.query, { convert: true });
    if (error) throw new HttpError(error.message, 400);

    const result = await LawSvc.getDocument({
      category: parseLawCategory(value.category),
      id: value.id,
    });
    return res.status(200).json(result);
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
