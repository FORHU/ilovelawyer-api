import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import LegalSourceCacheRepo from "../repositories/legal-source-cache.repository";
import { callChatWonderRest, getChatWonderSessionId } from "../utils/chatWonder";
import HttpError from "../utils/http-error";
import { EMPTY_PLACEHOLDER } from "../constants/legalSourceCache.constants";
import { getSourceAnalysisPromptTemplate } from "../legal/prompt-registry";
import { normalizeKeyword, cleanAiText, normalizeLetterSpacing, extractYearHint, extractRagSearchTerms } from "../utils/legalSourceCache.utils";
import { TenantCode } from "../types/tenant-code";

interface RagMatch {
  id: bigint;
  title: string | null;
  source_url: string | null;
  formatted_markdown: string | null;
  concise_summary: string | null;
}

async function findInRagDb(rawKeyword: string): Promise<RagMatch | null> {
  const terms = extractRagSearchTerms(rawKeyword);
  const yearHint = extractYearHint(rawKeyword);

  try {
    if (terms.length > 0) {
      const conditions = terms.map((term) => Prisma.sql`title ILIKE ${`%${term}%`}`);
      const where = Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}`;
      const rows = await prisma.$queryRaw<RagMatch[]>`
        SELECT id, title, source_url, formatted_markdown, concise_summary
        FROM documents
        ${where}
        ORDER BY
          CASE WHEN year = ${yearHint ?? 0} THEN 0 ELSE 1 END,
          CASE WHEN formatted_markdown IS NOT NULL AND char_length(formatted_markdown) > 100 THEN 0 ELSE 1 END,
          year DESC NULLS LAST
        LIMIT 1
      `;
      if (rows[0]) return rows[0];
    }

    const ftsQuery = rawKeyword.replace(/\(\d{4}\)/g, "").replace(/\blaw\b/gi, "").trim();
    if (!ftsQuery) return null;

    const rows = await prisma.$queryRaw<RagMatch[]>`
      SELECT id, title, source_url, formatted_markdown, concise_summary
      FROM documents
      WHERE to_tsvector('english', COALESCE(full_text, '')) @@ plainto_tsquery('english', ${ftsQuery})
        AND formatted_markdown IS NOT NULL AND char_length(formatted_markdown) > 100
      ORDER BY ts_rank(to_tsvector('english', COALESCE(full_text, '')), plainto_tsquery('english', ${ftsQuery})) DESC
      LIMIT 1
    `;
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

let sharedSessionId: string | null = null;

async function getSharedSessionId(): Promise<string> {
  if (sharedSessionId) return sharedSessionId;
  sharedSessionId = await getChatWonderSessionId();
  return sharedSessionId;
}

export default class LegalSourceCacheSvc {
  static async analyze(rawKeyword: string, tenantCode: TenantCode) {
    if (!rawKeyword.trim()) throw new HttpError("keyword is required", 400);

    const normalizedKeyword = normalizeKeyword(rawKeyword);
    if (!normalizedKeyword) throw new HttpError("keyword is invalid after normalization", 400);

    // Tier 1: cache hit — scoped to this tenant, never shared across PH/UK.
    const cached = await LegalSourceCacheRepo.findByNormalizedKeyword(normalizedKeyword, tenantCode);
    if (cached && !cached.markdownContent.includes(EMPTY_PLACEHOLDER)) {
      return { item_id: cached.id, type: "keyword_analysis", title: cached.title, url: cached.sourceUrl ?? "", text_content: cached.markdownContent, formatted_markdown: cached.markdownContent, cached: true };
    }

    // Tier 2: RAG DB match — the `documents` corpus is a PH-only ingested case-law/statute
    // database (see CONTEXT.md). Never consult it for a UK query; skip straight to Tier 3.
    if (tenantCode === "PH") {
      const ragDoc = await findInRagDb(rawKeyword);
      if (ragDoc) {
        const markdownContent = normalizeLetterSpacing(ragDoc.formatted_markdown?.trim() || ragDoc.concise_summary?.trim() || "");
        if (markdownContent) {
          const title = ragDoc.title || rawKeyword;
          const persisted = await LegalSourceCacheRepo.upsert({ rawKeyword, normalizedKeyword, tenantCode, title, markdownContent, rawResponse: markdownContent, sourceUrl: ragDoc.source_url });
          return { item_id: persisted.id, type: "keyword_analysis", title: persisted.title, url: persisted.sourceUrl ?? "", text_content: persisted.markdownContent, formatted_markdown: persisted.markdownContent, cached: false };
        }
      }
    }

    // Tier 3: Chat Wonder generation
    const prompt = getSourceAnalysisPromptTemplate(tenantCode).replace("{{KEYWORD}}", rawKeyword);
    let sessionId = await getSharedSessionId();
    let chatPayload: { response?: string; intermediate_response?: string; source_metadata?: unknown };

    try {
      chatPayload = await callChatWonderRest(prompt, sessionId);
    } catch {
      sessionId = await getChatWonderSessionId();
      sharedSessionId = sessionId;
      chatPayload = await callChatWonderRest(prompt, sessionId);
    }

    const rawResponse = String(chatPayload.response || chatPayload.intermediate_response || "").trim();
    const markdownContent = normalizeLetterSpacing(cleanAiText(rawResponse) || rawResponse || `# ${rawKeyword}\n\n${EMPTY_PLACEHOLDER}`);
    const sourceUrl = Array.isArray(chatPayload.source_metadata) && chatPayload.source_metadata.length > 0
      ? (chatPayload.source_metadata[0] as Record<string, unknown>)?.source_url as string ?? null
      : null;

    const persisted = await LegalSourceCacheRepo.upsert({
      rawKeyword,
      normalizedKeyword,
      tenantCode,
      title: rawKeyword,
      markdownContent,
      rawResponse,
      sourceUrl,
      metadataJson: chatPayload.source_metadata ?? null,
    });

    return { item_id: persisted.id, type: "keyword_analysis", title: persisted.title, url: persisted.sourceUrl ?? "", text_content: persisted.markdownContent, formatted_markdown: persisted.markdownContent, cached: false };
  }
}
