import LegalRagRepo from "../repositories/legal-rag.repository";
import HttpError from "../utils/http-error";
import { redis } from "../lib/redis";
import { embedText } from "../utils/embedding";
import { CHAT_WONDER_API_URL } from "../config";
import { LIBRARY_SECTIONS } from "../constants/library-sections.constants";

const CACHE_TTL_S  = 60 * 60;
const CACHE_TTL_MS = CACHE_TTL_S * 1000;
const CACHE_MAX    = 100;

interface CacheEntry { data: unknown; ts: number }
const l1 = new Map<string, CacheEntry>();

function l1Get(key: string): unknown | null {
  const entry = l1.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { l1.delete(key); return null; }
  return entry.data;
}

function l1Set(key: string, data: unknown): void {
  if (l1.size >= CACHE_MAX) {
    const oldest = [...l1.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) l1.delete(oldest[0]);
  }
  l1.set(key, { data, ts: Date.now() });
}

export default class LegalRagSvc {
  static async getCategories() {
    return LegalRagRepo.getCategories();
  }

  static async getSubcategories(category: string) {
    return LegalRagRepo.getSubcategories(category);
  }

  static async list(params: {
    page: number;
    limit: number;
    category?: string;
    subcategory?: string;
    noSubcategory?: boolean;
    year?: number;
    search?: string;
  }) {
    return LegalRagRepo.list(params);
  }

  static async getLibrarySections() {
    return Promise.all(
      LIBRARY_SECTIONS.map(async (section) => ({
        key: section.key,
        items: await Promise.all(
          section.items.map(async (item) => ({
            key: item.key,
            mode: item.mode,
            category: item.category,
            subcategory: item.subcategory ?? null,
            noSubcategory: item.noSubcategory ?? false,
            query: item.query ?? null,
            count:
              item.mode === "browse" && item.category
                ? await LegalRagRepo.countByCategory(item.category, item.subcategory, item.noSubcategory)
                : null,
          })),
        ),
      })),
    );
  }

  static async vectorSearch(embedding: number[], limit: number, offset: number, minSimilarity: number) {
    const rows = await LegalRagRepo.vectorSearch(embedding, { limit, offset, minSimilarity });

    return rows.map((r) => ({
      id: r.id.toString(),
      document_id: r.document_id.toString(),
      chunk_index: r.chunk_index,
      chunk_text: r.chunk_text,
      char_count: r.char_count,
      created_at: r.created_at,
      similarity: r.similarity,
      document: {
        id: r.document_id.toString(),
        title: r.doc_title,
        category: r.doc_category,
        subcategory: r.doc_subcategory,
        case_no: r.doc_case_no,
        year: r.doc_year,
        source_url: r.doc_source_url,
        concise_summary: r.doc_concise_summary,
      },
    }));
  }

  static async getRelated(id: number, limit: number) {
    const rows = await LegalRagRepo.findRelated(BigInt(id), limit);
    return rows.map((r) => ({ ...r, id: r.id.toString() }));
  }

  static async getById(id: number) {
    const doc = await LegalRagRepo.findById(BigInt(id));
    if (!doc) throw new HttpError("Case law document not found", 404);
    return doc;
  }

  static async getSourcePageDoc(itemId: string, titleHint?: string) {
    if (!/^\d+$/.test(itemId)) throw new HttpError("item_id must be a numeric legal document id", 400);

    const cacheKey = `legal:doc:${itemId}`;

    // L1 — in-process map
    const fromL1 = l1Get(cacheKey);
    if (fromL1) return fromL1;

    // L2 — Redis
    const fromRedis = await redis.get<unknown>(cacheKey);
    if (fromRedis) {
      l1Set(cacheKey, fromRedis);
      return fromRedis;
    }

    // Cache miss — query Postgres
    let doc = await LegalRagRepo.findByIdForSourcePage(BigInt(itemId));

    if (!doc && titleHint) {
      doc = await LegalRagRepo.findByTitleOrCaseNo(titleHint);
    }

    if (!doc) throw new HttpError("Document not found", 404);

    const metadata = (doc.metadata_json ?? {}) as Record<string, string>;
    const textContent = doc.full_text || doc.summary || doc.concise_summary || "";

    const result = {
      item_id: String(doc.id),
      type: doc.category,
      title: doc.title,
      url: doc.source_url,
      text_content: textContent,
      formatted_markdown: doc.formatted_markdown?.trim() || null,
      gr_number: metadata.gr_number ?? "",
      law_number: metadata.law_number ?? "",
      date: metadata.date ?? "",
      year: doc.year ?? "",
    };

    l1Set(cacheKey, result);
    redis.set(cacheKey, result, CACHE_TTL_S);

    return result;
  }

  static async formatDocument(id: number, opts: { force?: boolean; generateTitle?: boolean }) {
    const forward = new URLSearchParams();
    if (opts.force) forward.set("force", "true");
    if (opts.generateTitle === false) forward.set("generate_title", "false");
    const qs = forward.toString() ? `?${forward.toString()}` : "";

    const response = await fetch(`${CHAT_WONDER_API_URL}/api/legal/format-document/${id}${qs}`, { method: "POST" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new HttpError(data.detail || data.error || "Format failed", response.status);
    return data;
  }

  static async formatDocuments(opts: { force?: boolean; all?: boolean; generateTitle?: boolean; limit?: number; delay?: number }) {
    const forward = new URLSearchParams();
    if (opts.force) forward.set("force", "true");
    if (opts.all) forward.set("all", "true");
    if (opts.generateTitle === false) forward.set("generate_title", "false");
    if (opts.limit !== undefined) forward.set("limit", String(opts.limit));
    if (opts.delay !== undefined) forward.set("delay", String(opts.delay));
    const qs = forward.toString();

    const response = await fetch(`${CHAT_WONDER_API_URL}/api/legal/format-documents${qs ? `?${qs}` : ""}`, {
      method: "POST",
      signal: AbortSignal.timeout(60 * 60 * 1000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new HttpError(data.detail || data.error || "Batch format failed", response.status);
    return data;
  }

  static async search(query: string, limit: number) {
    const cacheKey = `legal:search:${Buffer.from(query.toLowerCase()).toString("base64")}:${limit}`;

    const cached = await redis.get<unknown>(cacheKey);
    if (cached) return cached;

    const embedding = await embedText(query);
    const rows = await LegalRagRepo.searchByVector(embedding, limit);

    const results = rows.map((r) => ({
      document_id: r.document_id.toString(),
      title: r.title,
      category: r.category,
      chunk_text: r.chunk_text,
    }));

    redis.set(cacheKey, results, CACHE_TTL_S);
    return results;
  }
}
