import HttpError from "../../../utils/http-error";
import LegalSourceCacheSvc from "../../../services/legal-source-cache.service";
import { LegalKnowledgeProvider } from "../../legal-knowledge-provider";

/**
 * UK has no ingested case-law/statute corpus yet (see docs/uk-legal-corpus-contract.md for what
 * a future UK ingestion pipeline must provide). Every corpus-backed method rejects with a
 * coming-soon error rather than reading the PH-only `documents` table — this is the enforcement
 * point that keeps UK from ever silently falling back to PH legal knowledge.
 *
 * analyzeKeyword is the one exception: LegalSourceCacheSvc already generates a UK answer via the
 * UK prompt template (legal/uk/prompts/legal-source-cache.prompt.ts, LEGAL_REVIEW_REQUIRED) and
 * never touches the PH corpus for a UK query, so it's real, jurisdiction-safe functionality —
 * not fabricated, not a PH fallback — and stays available here.
 */
export class UKLegalKnowledgeProvider implements LegalKnowledgeProvider {
  readonly jurisdiction = "UK" as const;
  readonly corpusAvailable = false;

  // async so every corpus method rejects with a Promise (matching the interface's Promise-based
  // contract) instead of throwing synchronously before the caller's `await` ever runs.
  private async unavailable(): Promise<never> {
    throw new HttpError("UK legal research corpus is not yet available — coming soon", 501);
  }

  async getCategories(): Promise<never> {
    return this.unavailable();
  }

  async getSubcategories(): Promise<never> {
    return this.unavailable();
  }

  async list(): Promise<never> {
    return this.unavailable();
  }

  async getLibrarySections(): Promise<never> {
    return this.unavailable();
  }

  async search(): Promise<never> {
    return this.unavailable();
  }

  async vectorSearch(): Promise<never> {
    return this.unavailable();
  }

  async getById(): Promise<never> {
    return this.unavailable();
  }

  async getRelated(): Promise<never> {
    return this.unavailable();
  }

  async getSourcePageDoc(): Promise<never> {
    return this.unavailable();
  }

  analyzeKeyword(keyword: string) {
    return LegalSourceCacheSvc.analyze(keyword, "UK");
  }
}

/**
 * The live AI consultation chat (chat.service.ts -> chatWonder.ts) is grounded through the
 * external chat-wonder-v2-api service, which has no jurisdiction-aware tool routing yet (its
 * search_jurisprudence/search_republic_acts/get_case/get_republic_act MCP tools are PH-only,
 * "juris.ph"). This is a separate repo, not covered by this codebase. The `jurisdiction` field
 * added to its request payloads (see chatWonder.ts) is additive plumbing only — this flag marks
 * that chat-wonder-v2-api itself has not yet been updated to consume it or provide a UK persona.
 * Structured AI features (red-team, case-finding, case-reconstruction, case-strategy, chat
 * titles) are unaffected — those already route through prompt-registry.ts's UK builders.
 */
export const UK_PERSONA_PENDING = true;
