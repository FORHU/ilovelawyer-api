import { LawCategory } from "@prisma/client";
import LawRepo from "../repositories/law.repository";
import LawSvc from "../services/law.service";
import { UK_CASELAW_BASE_URL, UK_LEGISLATION_BASE_URL } from "../config";
import { TenantCode } from "../types/tenant-code";
import type { RelatedCase } from "./chatWonder";
import { normalizeUkLegislationUrl, resolveUkCitationToLaw, resolveUkLegislationTitleToLaw } from "./uk-citation-resolution";
import logger from "./logger";

export interface CitationRewriteResult {
  content: string;
  rewrittenCount: number;
  attemptedCount: number;
  /** Citations that could not be resolved to a Library item and were stripped down to plain,
   * non-clickable text rather than left as an external link — see the "no fallback" policy on
   * `rewriteLegalCitationLinks`. */
  strippedCount: number;
}

// A surviving citation's URL is always an exact match from that turn's retrieved tool results
// (legal_citations.py's gate_unverified_legal_urls), but the surrounding syntax differs: plain
// markdown `[label](url)` is what survives when the reply isn't in "legal mode," but the normal
// legal-mode path additionally runs the gated markdown through format_legal_citation_links,
// which rewrites every `[<label> Law](url)` / `[<label> Jurisprudence](url)` into an HTML anchor
// — `<a href="url" class="legal-ref law|jurisprudence" target="_blank"><label> Law</a>` — before
// it ever reaches ilovelawyer-api. That HTML form is what a real citation (like the ones in the
// user's own report) actually looks like in `Message.content`, so both must be matched or this
// rewrite silently finds nothing to do. Mirrors assistant-message.tsx's own convertHtmlAnchors
// regex for the HTML form, so both sides agree on what counts as a citation anchor.
const MD_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
const HTML_LINK_RE = /<a\s+[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

// Caps how long a chat turn's persistence can be held up resolving citations against the UK
// Legal MCP (a real network round trip, TIMEOUT_MS = 10s in uk-legal-mcp.ts). Whatever hasn't
// resolved by then falls back to today's external-link behavior for that citation only.
const REWRITE_TIMEOUT_MS = 4_500;

const WIRE_CATEGORY: Record<TenantCode, Record<LawCategory, string>> = {
  UK: { JURISPRUDENCE: "uk-case-law", REPUBLIC_ACT: "uk-legislation" },
  PH: { JURISPRUDENCE: "jurisprudence", REPUBLIC_ACT: "republic-acts" },
};

interface Resolution {
  /** The Library detail route's `[id]` segment — NOT uniformly `Law.id`. Per
   * law.controller.ts's own doc comment on GET /api/law/document, that endpoint's `id` is
   * "the juris source id for PH and our Law.id uuid for UK" — a real, tenant-dependent
   * asymmetry in the existing API contract, not something this module gets to normalize away.
   * UK resolvers set this to `Law.id`; the PH resolver sets it to the juris.ph item id instead. */
  routeId: string;
  category: LawCategory;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function libraryHref(tenantCode: TenantCode, resolution: Resolution): string {
  return `/homepage/library/laws/${resolution.routeId}?category=${WIRE_CATEGORY[tenantCode][resolution.category]}`;
}

// The model is instructed to suffix a citation label with a literal " Law"/" Jurisprudence"
// (see legal_prompt*.txt), but the gate step only requires a matching URL, not the suffix — so
// it's optional here too. Neither citations_resolve nor LawSvc.search expects the literal word.
export function stripCitationSuffix(label: string): string {
  return label.replace(/\s+(Law|Jurisprudence)$/i, "").trim();
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

const UK_LEGISLATION_HOST = hostnameOf(UK_LEGISLATION_BASE_URL);
const UK_CASELAW_HOST = hostnameOf(UK_CASELAW_BASE_URL);

/** "legislation" | "caselaw" | null, matched by hostname rather than a raw string-prefix
 * comparison against UK_LEGISLATION_BASE_URL/UK_CASELAW_BASE_URL. A prefix check silently
 * rejects every citation whose URL differs from the configured base in scheme, "www.", or case
 * (e.g. an MCP-returned "https://legislation.gov.uk/..." against a "https://www.legislation.gov.uk"
 * base) — which looks identical to "not a Library-backed host" and falls through to the external
 * fallback even for a document that's genuinely already in the Library. */
function ukHostKind(href: string): "legislation" | "caselaw" | null {
  const host = hostnameOf(href);
  if (!host) return null;
  if (host === UK_LEGISLATION_HOST) return "legislation";
  if (host === UK_CASELAW_HOST) return "caselaw";
  return null;
}

export function isKnownLawHost(href: string, tenantCode: TenantCode): boolean {
  if (tenantCode === "UK") return ukHostKind(href) !== null;
  return hostnameOf(href) === "juris.ph";
}

/** UK: fast path is an exact `Law.jurisSourceId` lookup (pinpoint-normalized for legislation);
 * slow path re-verifies the citation's own label against the UK Legal MCP and materializes a
 * new Law row on first sight (resolveUkCitationToLaw already does both, category bug fixed). */
async function resolveUkHref(href: string, label: string): Promise<Resolution | null> {
  const isLegislation = ukHostKind(href) === "legislation";
  const category: LawCategory = isLegislation ? "REPUBLIC_ACT" : "JURISPRUDENCE";

  const jurisSourceId = isLegislation ? normalizeUkLegislationUrl(href) : href;
  const existing = await LawRepo.findByJurisSourceId(jurisSourceId);
  if (existing) return { routeId: existing.id, category };

  const strippedLabel = stripCitationSuffix(label);
  if (isLegislation) {
    // citations_resolve only understands "s.N Act YYYY" — the AI's actual citation order is
    // the reverse ("Act YYYY, s N"), which it flatly rejects, and even the form it does accept
    // can resolve to a generic search page instead of a document (see
    // resolveUkLegislationTitleToLaw's doc comment). A plain title search handles the AI's
    // real phrasing, so it's tried first; the OSCOLA resolver is only a fallback for the rare
    // case the label already happens to be in strict citation form (e.g. a bare "SI YYYY/N").
    const byTitle = await resolveUkLegislationTitleToLaw(strippedLabel);
    if (byTitle) return { routeId: byTitle.lawId, category };
  }

  const resolved = await resolveUkCitationToLaw(strippedLabel);
  if (!resolved) return null;
  return { routeId: resolved.lawId, category };
}

const JURIS_PH_PATH_RE = /^\/(case|republic-act)\/([^/?#]+)/;

/** PH citation URLs (juris-ph.ts) already embed the exact juris.ph item id that
 * `Law.jurisSourceId` is keyed on (`https://juris.ph/case/{id}` / `.../republic-act/{id}`), so
 * this is an exact-id lookup, not a fuzzy title match — reuses LawSvc.getDocument, the same
 * write-through-on-miss path the Library detail page itself uses, purely to materialize the row
 * (and confirm it's real) on first sight.
 *
 * The returned `routeId` is that same juris.ph id, NOT `doc.item.stored_id` (our internal
 * `Law.id`) — GET /api/law/document takes "the juris source id for PH and our Law.id uuid for
 * UK" (law.controller.ts), so the Library route for a PH document is keyed on the juris.ph id
 * throughout, unlike UK's. Using `stored_id` here would 404 the detail page: confirmed live
 * (a citation resolved to a Library link that failed to load until this was fixed). */
async function resolvePhHref(href: string): Promise<Resolution | null> {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  const match = url.pathname.match(JURIS_PH_PATH_RE);
  if (!match) return null;
  const category: LawCategory = match[1] === "case" ? "JURISPRUDENCE" : "REPUBLIC_ACT";
  const id = decodeURIComponent(match[2]);

  try {
    await LawSvc.getDocument({ category, id });
    return { routeId: id, category };
  } catch {
    return null;
  }
}

/**
 * Rewrites inline `[label](href)` legal citation links in an already-gated chat answer so a
 * citation the app already stores (or can materialize) in the Library links in-app instead of
 * out to legislation.gov.uk / caselaw.nationalarchives.gov.uk / juris.ph. Only the href changes
 * on a resolved citation — the model's own label (often more precise than the Library's stored
 * title, e.g. carrying a pinpoint section) is left untouched.
 *
 * No-external-navigation policy: a citation link must never leave the app, and the app has no
 * Library page to send a user to for a document it can't identify — so a citation that isn't (or
 * can't be) resolved to a Library item, for any reason (unrecognized host, resolution genuinely
 * failed, or the time budget ran out), is stripped down to its plain label text rather than left
 * as a clickable external link. This intentionally also strips any non-legal link that happens
 * to match the citation syntax, since there's no way to tell "harmless external reference" apart
 * from "unresolved citation" at this layer — see the doc comment on assistant-message.tsx's `a`
 * renderer for the frontend half of this contract (only an internal Library href stays clickable).
 * Never throws — a total failure degrades to "no citations rewritten this turn," original links
 * intact (a rarer, coarser-grained fallback than the stripping done for a single unresolved
 * citation, reserved for a bug in this function itself).
 */
export async function rewriteLegalCitationLinks(
  content: string,
  tenantCode: TenantCode,
): Promise<CitationRewriteResult> {
  try {
    const mdMatches = [...content.matchAll(MD_LINK_RE)];
    const htmlMatches = [...content.matchAll(HTML_LINK_RE)];
    if (mdMatches.length === 0 && htmlMatches.length === 0) {
      return { content, rewrittenCount: 0, attemptedCount: 0, strippedCount: 0 };
    }

    const labelByHref = new Map<string, string>();
    for (const [, label, href] of mdMatches) {
      if (!labelByHref.has(href)) labelByHref.set(href, label);
    }
    for (const [, href, label] of htmlMatches) {
      if (!labelByHref.has(href)) labelByHref.set(href, label);
    }

    // Only a known law host is even worth attempting — a Hansard/Parliament/etc. URL has no
    // chance of matching a Library item, so it skips straight to "will be stripped," no I/O.
    const attempted = [...labelByHref.keys()].filter((href) => isKnownLawHost(href, tenantCode));

    const resolutions = new Map<string, Resolution | null>();
    if (attempted.length > 0) {
      const resolveAll = Promise.all(
        attempted.map(async (href) => {
          try {
            const resolution =
              tenantCode === "UK" ? await resolveUkHref(href, labelByHref.get(href)!) : await resolvePhHref(href);
            resolutions.set(href, resolution);
          } catch (err) {
            logger.warn("Legal citation link rewrite: resolution failed for one href, it will be stripped", {
              err,
              tenantCode,
            });
          }
        }),
      );
      await Promise.race([resolveAll, sleep(REWRITE_TIMEOUT_MS)]);
    }

    let rewrittenCount = 0;
    let strippedCount = 0;
    const rewrite = (label: string, href: string): string => {
      const resolution = resolutions.get(href);
      if (resolution) {
        rewrittenCount += 1;
        return `[${label}](${libraryHref(tenantCode, resolution)})`;
      }
      strippedCount += 1;
      return label;
    };
    const rewritten = content
      .replace(MD_LINK_RE, (_full, label: string, href: string) => rewrite(label, href))
      .replace(HTML_LINK_RE, (_full, href: string, label: string) => rewrite(label, href));

    return { content: rewritten, rewrittenCount, attemptedCount: attempted.length, strippedCount };
  } catch (err) {
    logger.warn("Legal citation link rewrite: failed, keeping original links", { err, tenantCode });
    return { content, rewrittenCount: 0, attemptedCount: 0, strippedCount: 0 };
  }
}

function hasOwnLabel(item: RelatedCase): boolean {
  return !!(item.title?.trim() || item.case_number?.trim() || item.ra_number?.trim());
}

// The Sources panel derives a readable label from `url` (host + path) for an item that arrived
// with no title/case_number/ra_number at all — its only source of identifying text. Stripping
// `url` on an unresolved citation (the no-external-navigation policy) would leave such an item
// with nothing to display at all, a real regression from "external link with a derived label" to
// "blank row." Backfilling `title` with the same kind of derivation before stripping keeps the
// row identifiable without a clickable link. legislation.gov.uk items rarely hit this: they
// already got a real title from enrichRelatedCaseTitles (chat.service.ts) before this function
// ever runs — this is mainly a safety net for a bare TNA case URL that also fails resolution.
function fallbackTitle(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./i, "");
    return `${host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
}

/**
 * The Related Cases / "authorities cited" panel (Sources panel) is a second, structurally
 * separate citation surface from the inline chat prose above — its items already carry
 * `{title, url, case_number, ra_number}` directly (no markdown/HTML parsing needed), but the
 * `url` was never run through any Library resolution at all, so it still always pointed
 * externally. This applies the exact same resolution + no-external-navigation policy as
 * `rewriteLegalCitationLinks` (see its doc comment), reusing `resolveUkHref`/`resolvePhHref`
 * directly rather than a second implementation.
 */
export async function resolveRelatedCaseLibraryLinks(
  items: RelatedCase[],
  tenantCode: TenantCode,
): Promise<RelatedCase[]> {
  const strip = (item: RelatedCase): RelatedCase => ({
    ...item,
    url: null,
    title: hasOwnLabel(item) ? item.title : fallbackTitle(item.url!),
  });

  return Promise.all(
    items.map(async (item) => {
      if (!item.url) return item;
      if (!isKnownLawHost(item.url, tenantCode)) return strip(item);

      try {
        const resolution =
          tenantCode === "UK"
            ? await resolveUkHref(item.url, item.title ?? item.case_number ?? item.ra_number ?? "")
            : await resolvePhHref(item.url);
        return resolution ? { ...item, url: libraryHref(tenantCode, resolution) } : strip(item);
      } catch (err) {
        logger.warn("Related case link resolution failed, stripping the external link", { err, url: item.url });
        return strip(item);
      }
    }),
  );
}
