import HttpError from "../utils/http-error";
import type { TenantCode } from "../types/tenant-code";
import { FEE_CURRENCY_BY_COUNTRY } from "./lawyer-application.constants";

/**
 * What the client app offers on each site (uk-client / ph-client / kr-client). Every site has
 * sign-up, cases and documents. The rest opens site by site; the client app's site config
 * (ilovelawyer-client/src/lib/tenant/sites.ts) shows "coming soon" for what's closed, and these
 * are the guard behind it.
 */

/** Sites where a client's AI runs: the intake chat and what's built on it (overview, intake
 * summary, lawyer readiness, email suggestions). The intake persona is UK-specific, and it must
 * never answer a client of another country, so a site opens once it has its own persona in
 * Chat Wonder. KR has one (intake_kr, reached by the jurisdiction intakeChatWonder.ts sends), so
 * the Chat Wonder it talks to must have it deployed. */
export const CLIENT_AI_OPEN_TENANTS: ReadonlySet<TenantCode> = new Set(["UK", "KR"]);

/** Sites where a client can find, ask for and hire a lawyer. A request stays on its client's site:
 * only that site's verified lawyers see it (ClientRequestMatchingSvc.matches), and they quote and are
 * paid in its currency (requestCurrencyOf). A lawyer on a site that isn't open gets
 * CLIENT_REQUESTS_NOT_OPEN. */
export const CLIENT_REQUESTS_OPEN_TENANTS: ReadonlySet<TenantCode> = new Set(["UK", "KR"]);

/** What a site's client requests are quoted, paid and earned in: GBP on UK, KRW on KR. */
export function requestCurrencyOf(tenantCode: TenantCode): string {
  return FEE_CURRENCY_BY_COUNTRY[tenantCode];
}

/** The UK alone has parts with their own law (England and Wales, Scotland, Northern Ireland): a UK
 * request needs one, and a lawyer qualified in it. Another site's request has no part to match. */
export function needsUkRegion(tenantCode: string): boolean {
  return tenantCode === "UK";
}

export function assertClientAiOpen(tenantCode: TenantCode): void {
  if (!CLIENT_AI_OPEN_TENANTS.has(tenantCode)) {
    throw new HttpError("The AI chat isn't available on this site yet.", 403, "CLIENT_AI_NOT_OPEN");
  }
}

export function assertClientRequestsOpen(tenantCode: TenantCode): void {
  if (!CLIENT_REQUESTS_OPEN_TENANTS.has(tenantCode)) {
    throw new HttpError("Lawyers aren't available on this site yet.", 403, "CLIENT_REQUESTS_NOT_OPEN");
  }
}
