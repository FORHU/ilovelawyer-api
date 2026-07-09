import LegalRagRepo from "../repositories/legal-rag.repository";
import HttpError from "../utils/http-error";
import { redis } from "../lib/redis";

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
  static async list(page: number, limit: number, category?: string, year?: number, search?: string) {
    return LegalRagRepo.list({ page, limit, category, year, search });
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
}
