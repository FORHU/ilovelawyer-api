import { LawCategory } from "@prisma/client";
import ChatRepo from "../repositories/chat.repository";
import LawRepo from "../repositories/law.repository";
import logger from "../utils/logger";
import { TenantCode } from "../types/tenant-code";
import { WIRE_CATEGORY } from "../utils/law-library-href";
import { stripCitationSuffix } from "../utils/legal-citation-link-rewrite";
import { RankableAuthority, RankResult, rankAuthority } from "../utils/citation-rank";
import { isCitationRankJevEnabled, rateAuthoritiesWithJev } from "../utils/citation-rank-jev";

/** What the app reads per message: one entry per Library href that earned a tier. A link with no
 * entry is unrated and renders neutral. */
export interface CitationRankItem {
  href: string;
  tier: "HIGH" | "MEDIUM" | "LOW";
  relevance: string | null;
  importance: string | null;
  reason: string;
  namedByUser: boolean;
}

export interface LibraryLink {
  href: string;
  routeId: string;
  category: LawCategory;
  label: string;
}

/** The subset of a Law row the ranker reads. */
export interface LawLike {
  id: string;
  jurisSourceId: string;
  category: LawCategory;
  title: string;
  year: number | null;
  division: string | null;
  sourceUrl: string | null;
  jurisUrl: string;
  summary: string | null;
  facts: string | null;
  disposition: string | null;
  courtReasoning: string | null;
  legalRulesCited: string[];
  legalIssues: string[];
  keyProvisions: string[];
}

// `[label](/homepage/library/laws/<id>?category=<wire>[&section=<n>])` — the form
// rewriteLegalCitationLinks leaves in Message.content. The label may hold brackets
// ("[2004] EWCA Crim 2375").
const LIBRARY_LINK_RE = /\[((?:[^\[\]]|\[[^\]]*\])*)\]\((\/homepage\/library\/laws\/([^?)\s]+)\?category=([a-z-]+)(?:&section=[^)\s]+)?)\)/g;

/** Every distinct Library link in a reply's text, first label wins. Links whose category isn't one of
 * the tenant's wire categories are ignored. */
export function extractLibraryLinks(content: string, tenantCode: TenantCode): LibraryLink[] {
  const byWire = Object.fromEntries(Object.entries(WIRE_CATEGORY[tenantCode]).map(([cat, wire]) => [wire, cat as LawCategory]));
  const seen = new Map<string, LibraryLink>();
  for (const m of content.matchAll(LIBRARY_LINK_RE)) {
    const href = m[2];
    const category = byWire[m[4]];
    if (!category || seen.has(href)) continue;
    let routeId = m[3];
    try {
      routeId = decodeURIComponent(routeId);
    } catch {
      /* keep the raw segment */
    }
    seen.set(href, { href, routeId, category, label: stripCitationSuffix(m[1].replace(/\s+/g, " ").trim()) });
  }
  return [...seen.values()];
}

/** The authority's own words for Jev, most decision-relevant first (the cap in citation-rank-jev
 * trims from the end). Empty when the Library row holds nothing usable. */
export function lawText(law: LawLike): string {
  const parts = [
    law.summary,
    law.legalIssues.length ? `Issues: ${law.legalIssues.join("; ")}` : null,
    law.legalRulesCited.length ? `Rules cited: ${law.legalRulesCited.join("; ")}` : null,
    law.keyProvisions.length ? `Key provisions: ${law.keyProvisions.join("; ")}` : null,
    law.disposition ? `Disposition: ${law.disposition}` : null,
    law.courtReasoning,
    law.facts,
  ];
  return parts.filter((p): p is string => !!p?.trim()).join("\n");
}

export function toAuthority(link: LibraryLink, law: LawLike | undefined): RankableAuthority {
  return {
    id: link.href,
    label: link.label || law?.title || link.href,
    kind: link.category === "REPUBLIC_ACT" ? "legislation" : "case",
    sourceUrl: law ? law.sourceUrl ?? law.jurisUrl : null,
    division: law?.division ?? null,
    year: law?.year ?? null,
    text: law ? lawText(law) : null,
  };
}

/** Rated results to storable items. UNRATED never gets stored: absence is how the app knows to stay neutral. */
export function toItems(results: RankResult[]): CitationRankItem[] {
  return results
    .filter((r): r is RankResult & { tier: "HIGH" | "MEDIUM" | "LOW" } => r.tier !== "UNRATED")
    .map((r) => ({
      href: r.id,
      tier: r.tier,
      relevance: r.relevance,
      importance: r.importance,
      reason: r.reason,
      namedByUser: r.signals.namedByUser,
    }));
}

export interface RankReplyResult {
  /** Distinct links that earned a tier. */
  ranked: number;
  /** Messages a ranking was saved on. */
  messages: number;
}

const NOTHING: RankReplyResult = { ranked: 0, messages: 0 };

export default class CitationRankSvc {
  static get enabled() {
    return isCitationRankJevEnabled();
  }

  /**
   * Ranks every Library citation in one turn's assistant reply(ies) against the USER's message and
   * stores the result per message. A split multi-topic reply is ranked once as a whole; each sibling
   * message keeps the subset for the links in its own text. Runs after chat:done and never throws:
   * a failure just leaves the links neutral (decision D8).
   */
  static async rankReply(args: { parentMessageId: string; tenantCode: TenantCode }): Promise<RankReplyResult> {
    const { parentMessageId, tenantCode } = args;
    try {
      if (!CitationRankSvc.enabled) return NOTHING;
      const [replies, userMessage] = await Promise.all([
        ChatRepo.findAssistantRepliesByParent(parentMessageId),
        ChatRepo.findUserMessageContent(parentMessageId),
      ]);
      if (!userMessage?.trim() || !replies.length) return NOTHING;

      const links = new Map<string, LibraryLink>();
      for (const reply of replies) for (const l of extractLibraryLinks(reply.content, tenantCode)) if (!links.has(l.href)) links.set(l.href, l);
      if (!links.size) return NOTHING;

      const all = [...links.values()];
      const laws: LawLike[] =
        tenantCode === "PH"
          ? await LawRepo.findByJurisSourceIds(all.map((l) => l.routeId))
          : await LawRepo.findManyByIds(all.map((l) => l.routeId));
      const lawByRouteId = new Map(laws.map((law) => [tenantCode === "PH" ? law.jurisSourceId : law.id, law as LawLike]));

      const authorities = all.map((l) => toAuthority(l, lawByRouteId.get(l.routeId)));
      const ratings = await rateAuthoritiesWithJev(userMessage, authorities);
      if (!ratings) return NOTHING;

      const results = authorities.map((a) => rankAuthority(a, userMessage, ratings.get(a.id) ?? null));
      const items = toItems(results);
      if (!items.length) return NOTHING;

      let messages = 0;
      for (const reply of replies) {
        const own = items.filter((i) => reply.content.includes(`](${i.href})`));
        if (!own.length) continue;
        await ChatRepo.saveCitationRanking(reply.id, own);
        messages++;
      }
      logger.info("Citation ranking: saved", { parentMessageId, links: all.length, ranked: items.length, messages });
      return { ranked: items.length, messages };
    } catch (err) {
      logger.warn("Citation ranking: failed, links stay neutral", { parentMessageId, err });
      return NOTHING;
    }
  }
}
