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
export function libraryHref(tenantCode: TenantCode, routeId: string, category: LawCategory): string {
  return `/homepage/library/laws/${encodeURIComponent(routeId)}?category=${WIRE_CATEGORY[tenantCode][category]}`;
}

/** The Library detail route for a stored Law row: PH keys it on `jurisSourceId`, UK on `Law.id`. */
export function lawLibraryHref(tenantCode: TenantCode, law: { id: string; jurisSourceId: string; category: LawCategory }): string {
  return libraryHref(tenantCode, tenantCode === "PH" ? law.jurisSourceId : law.id, law.category);
}
