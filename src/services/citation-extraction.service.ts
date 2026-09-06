import LawRepo from "../repositories/law.repository";
import CitationEdgeRepo from "../repositories/citation-edge.repository";
import { fetchLawFullText } from "../utils/law-fulltext";
import { resolveCitationToLaw } from "../utils/citation-resolution";
import { buildCitationExtractionPrompt } from "../legal/ph/prompts";
import { extractCitations } from "../utils/citation-extraction-parse";
import { getChatWonderSessionId, streamChatWonderMessage } from "../utils/chatWonder";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";

// Keeps a single decision's prompt within a sane token budget — a full SC decision can run to
// tens of thousands of words; this is a length cap, not a quality target.
const MAX_TEXT_CHARS = 60_000;

export default class CitationExtractionSvc {
  /**
   * Cached, extract-once-per-Law citation edges (see Law.citationsExtractedAt). Never throws
   * on extraction failure — a decision with no usable text, or a malformed/empty LLM reply,
   * still stamps citationsExtractedAt with zero edges so a future view doesn't retry it forever.
   * Only a genuinely missing Law row is an error.
   */
  static async expand(lawId: string) {
    const law = await LawRepo.findById(lawId);
    if (!law) throw new HttpError("Law not found", 404);

    if (law.citationsExtractedAt) {
      return CitationEdgeRepo.listByFromLaw(lawId);
    }

    const fullText = await fetchLawFullText(law);
    const fallbackText = [law.facts, law.disposition, law.legalRulesCited.join(", ")]
      .filter(Boolean)
      .join("\n\n");
    const text = (fullText ?? fallbackText).slice(0, MAX_TEXT_CHARS);

    if (!text.trim()) {
      await LawRepo.markCitationsExtracted(lawId);
      return [];
    }

    const prompt = buildCitationExtractionPrompt({
      title: law.title,
      caseNumber: law.caseNumber,
      text,
      isFullText: !!fullText,
    });

    let sessionId = await getChatWonderSessionId();
    let result: { content: string };
    try {
      result = await streamChatWonderMessage(sessionId, prompt, () => {});
    } catch {
      sessionId = await getChatWonderSessionId();
      result = await streamChatWonderMessage(sessionId, prompt, () => {});
    }

    const extracted = extractCitations(result.content) ?? [];

    const edges = await Promise.all(
      extracted.map(async (item) => {
        const resolved = await resolveCitationToLaw({
          caseNumber: item.caseNumber,
          title: item.title,
          year: item.year,
        });
        return {
          fromLawId: lawId,
          toLawId: resolved?.lawId ?? null,
          toRawReference: resolved ? null : item.caseNumber,
          toRawTitle: resolved ? null : item.title,
          treatment: item.treatment,
          excerpt: item.excerpt,
          confidence: resolved?.confidence ?? null,
        };
      }),
    );

    await CitationEdgeRepo.createMany(edges);
    await LawRepo.markCitationsExtracted(lawId);

    logger.info("Citation extraction complete", {
      lawId,
      usedFullText: !!fullText,
      edgeCount: edges.length,
      resolvedCount: edges.filter((e) => e.toLawId).length,
    });

    return CitationEdgeRepo.listByFromLaw(lawId);
  }
}
