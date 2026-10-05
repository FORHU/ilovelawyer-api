import { LawCategory } from "@prisma/client";
import { TenantCode } from "../types/tenant-code";

/** The Library detail route's `?category=` value for each tenant and Law category. */
export const WIRE_CATEGORY: Record<TenantCode, Record<LawCategory, string>> = {
  UK: { JURISPRUDENCE: "uk-case-law", REPUBLIC_ACT: "uk-legislation" },
  PH: { JURISPRUDENCE: "jurisprudence", REPUBLIC_ACT: "republic-acts" },
};

/** The Library detail route (/homepage/library/laws/[id]) for a route id and category. The id is
 * NOT uniformly `Law.id` — GET /api/law/document takes "the juris source id for PH and our Law.id
 * uuid for UK" (law.controller.ts), so callers pass whichever the tenant uses. */
export function libraryHref(tenantCode: TenantCode, routeId: string, category: LawCategory, section?: string | null): string {
  const base = `/homepage/library/laws/${encodeURIComponent(routeId)}?category=${WIRE_CATEGORY[tenantCode][category]}`;
  // A pinpoint ("s 49") opens the Act at that section; without it every section of one Act
  // linked to the same page.
  return section ? `${base}&section=${encodeURIComponent(section)}` : base;
}

const SECTION_PATH_RE = /\/section\/([0-9]+[A-Z]*)(?:[/?#]|$)/i;
const SECTION_LABEL_RE = /(?:^|[\s,(])(?:ss?\.?|sections?)\s*([0-9]+[A-Z]*)\b/i;

/** The section a UK legislation citation points at — from its legislation.gov.uk URL
 * (".../ukpga/2015/15/section/49") or else its label ("Consumer Rights Act 2015, s 49",
 * "section 49"). Null when it cites the Act as a whole. */
export function legislationSection(href: string, label: string): string | null {
  return href.match(SECTION_PATH_RE)?.[1] ?? label.match(SECTION_LABEL_RE)?.[1] ?? null;
}

/** The Library detail route for a stored Law row: PH keys it on `jurisSourceId`, UK on `Law.id`. */
export function lawLibraryHref(tenantCode: TenantCode, law: { id: string; jurisSourceId: string; category: LawCategory }): string {
  return libraryHref(tenantCode, tenantCode === "PH" ? law.jurisSourceId : law.id, law.category);
}
