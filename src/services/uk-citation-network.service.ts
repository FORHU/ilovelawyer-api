import LawRepo from "../repositories/law.repository";
import CitationEdgeRepo, { CitationEdgeCreateInput } from "../repositories/citation-edge.repository";
import { getCitationsNetwork } from "../utils/uk-legal-mcp";
import { extractCaseUri, resolveUkCitationToLaw } from "../utils/uk-citation-resolution";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";

// UI/API-courtesy bound, not an LLM-cost cap (there's no LLM here) — a bit more generous than
// PH's cost-driven cap of 10.
const MAX_CITATIONS = 15;

interface RawCitation {
  raw: string;
  citationType: "case" | "legislation" | "si" | "eu";
}

export default class UkCitationNetworkSvc {
  /**
   * Cached, extract-once-per-Law citation edges from the UK Legal MCP's citations_network tool
   * — a real, structured answer, not an LLM inference, so unlike CitationExtractionSvc (PH) this
   * never needs a queue: it's ~15 lightweight HTTP calls to the MCP, fast enough to run inline.
   */
  static async expand(lawId: string) {
    const law = await LawRepo.findById(lawId);
    if (!law) throw new HttpError("Law not found", 404);

    if (law.citationsExtractedAt) {
      return CitationEdgeRepo.listByFromLaw(lawId);
    }

    const caseUri = extractCaseUri(law.jurisUrl);
    if (!caseUri) {
      // A legislation/SI/EU node (or anything not on TNA) has no judgment to fetch a network
      // for — it's always a leaf in the graph.
      await LawRepo.markCitationsExtracted(lawId);
      return [];
    }

    let network: Awaited<ReturnType<typeof getCitationsNetwork>>;
    try {
      network = await getCitationsNetwork(caseUri);
    } catch (err) {
      logger.warn("UK citation network fetch failed", { err, lawId, caseUri });
      await LawRepo.markCitationsExtracted(lawId);
      return [];
    }

    const grouped: RawCitation[] = [
      ...network.neutral_citations.map((raw): RawCitation => ({ raw, citationType: "case" })),
      ...network.law_report_refs.map((raw): RawCitation => ({ raw, citationType: "case" })),
      ...network.legislation_refs.map((raw): RawCitation => ({ raw, citationType: "legislation" })),
      ...network.si_refs.map((raw): RawCitation => ({ raw, citationType: "si" })),
      ...network.eu_refs.map((raw): RawCitation => ({ raw, citationType: "eu" })),
    ];

    // The judgment's own citation appears in its own network (confirmed live) — never link a
    // case to itself.
    const selfCitation = law.caseNumber;
    const candidates = grouped.filter((item) => item.raw !== selfCitation).slice(0, MAX_CITATIONS);

    const edges: CitationEdgeCreateInput[] = await Promise.all(
      candidates.map(async ({ raw, citationType }) => {
        const resolved = await resolveUkCitationToLaw(raw);
        return {
          fromLawId: lawId,
          toLawId: resolved?.lawId ?? null,
          toRawReference: resolved ? null : raw,
          toRawTitle: null,
          treatment: "CITED" as const,
          citationType,
          confidence: resolved?.confidence ?? null,
        };
      }),
    );

    await CitationEdgeRepo.createMany(edges);
    await LawRepo.markCitationsExtracted(lawId);

    logger.info("UK citation network expansion complete", {
      lawId,
      caseUri,
      totalCitations: network.total_citations,
      edgeCount: edges.length,
      resolvedCount: edges.filter((e) => e.toLawId).length,
    });

    return CitationEdgeRepo.listByFromLaw(lawId);
  }
}
