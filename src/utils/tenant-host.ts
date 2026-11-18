import { Request } from "express";
import { Role } from "@prisma/client";
import { TenantCode } from "../types/tenant-code";
import { CLIENT_URL, USER_APP_URL } from "../config";
import { DEFAULT_CLIENT_TENANT_CODE } from "../constants/auth.constants";
import { resolveClientApp } from "./client-app";

/**
 * Explicit hostname → Tenant code map. No substring/`.includes()` matching — an unrecognized
 * host always resolves to `null`, never guessed at. Keep in sync with the frontend's copy at
 * ilovelawyer-app/apps/web/lib/tenant-code/resolve-host.ts (two separate deployables, no
 * shared package between them).
 *
 * Three host conventions are recognized for local dev, all mapping to the same Tenant code:
 * `ph.ilovelawyer.local` (the spec's required form), and the bare `ph.ilovelawyer` this repo's
 * own frontend `next.config.ts` `allowedDevOrigins` already anticipated before this feature was
 * built (what this environment's hosts file actually points at) — plus the `.com` production
 * form, the `-dev.ilovelawyer.com` hosted dev environment, and its `-dev.ilovelawyer.local`
 * local-dev counterpart (`ph-dev.ilovelawyer.com` / `uk-dev.ilovelawyer.com` /
 * `ph-dev.ilovelawyer.local` / `uk-dev.ilovelawyer.local`). `ph-local.ilovelawyer.com` /
 * `uk-local.ilovelawyer.com` are local dev too (hosts file → 127.0.0.1, served over https) —
 * the only local form Google sign-in accepts as a JavaScript origin.
 */
const HOST_TENANT_CODE_MAP: Record<string, TenantCode> = {
  "ph.ilovelawyer.com": "PH",
  "ph-dev.ilovelawyer.com": "PH",
  "ph.ilovelawyer.local": "PH",
  "ph-dev.ilovelawyer.local": "PH",
  "ph-local.ilovelawyer.com": "PH",
  "ph.ilovelawyer": "PH",
  "ph.localhost": "PH",
  "uk.ilovelawyer.com": "UK",
  "uk-dev.ilovelawyer.com": "UK",
  "uk.ilovelawyer.local": "UK",
  "uk-dev.ilovelawyer.local": "UK",
  "uk-local.ilovelawyer.com": "UK",
  "uk.ilovelawyer": "UK",
  "uk.localhost": "UK",
  // Korea: prod kr.ilovelawyer.com, hosted dev kr-dev.ilovelawyer.com, local
  // http://kr-dev.ilovelawyer.local:3002 — plus the same extra dev forms PH and UK have.
  "kr.ilovelawyer.com": "KR",
  "kr-dev.ilovelawyer.com": "KR",
  "kr.ilovelawyer.local": "KR",
  "kr-dev.ilovelawyer.local": "KR",
  "kr-local.ilovelawyer.com": "KR",
  "kr.ilovelawyer": "KR",
  "kr.localhost": "KR",
  // The client app's hosts are deliberately absent: they're in CLIENT_HOST_TENANT_MAP below. This
  // map also decides where a lawyer's emailed links point (originForTenantCode), and a client
  // host here could send a lawyer's password reset to the client app, which refuses lawyers.
};

/**
 * The client app's (ilovelawyer-client) host → site map, kept apart from the lawyer hosts above and
 * read only for a request from the client app (X-Client-App: user). Exact matches only. Keep in sync
 * with ilovelawyer-client/src/lib/tenant/resolve-host.ts.
 *
 * `*-client.ilovelawyer.localhost` is local dev (browsers send *.localhost to 127.0.0.1 with no
 * hosts-file entry); `*-client-local.ilovelawyer.com` is local dev over https for Google sign-in;
 * `*-client-dev.ilovelawyer.com` the hosted dev environment; `*-client.ilovelawyer.com` production.
 */
const CLIENT_HOST_TENANT_MAP: Record<string, TenantCode> = Object.fromEntries(
  (["UK", "PH", "KR"] as const).flatMap((site) => {
    const prefix = site.toLowerCase();
    return [
      [`${prefix}-client.ilovelawyer.localhost`, site],
      [`${prefix}-client-local.ilovelawyer.com`, site],
      [`${prefix}-client-dev.ilovelawyer.com`, site],
      [`${prefix}-client.ilovelawyer.com`, site],
    ];
  }),
);

/** The client site a host belongs to, or null for a host that isn't one site's own. */
export function resolveClientTenantFromHost(hostname: string | undefined | null): TenantCode | null {
  if (!hostname) return null;
  const host = hostname.split(":")[0].trim().toLowerCase();
  return CLIENT_HOST_TENANT_MAP[host] ?? null;
}

/** The site a client-app page on `origin` shows: its host's own, or DEFAULT_CLIENT_TENANT_CODE (UK)
 * for any other host (localhost:3004, client-local, the old single domain), as the client app's
 * siteForHost does. Null for something that isn't a URL. */
export function clientSiteOfOrigin(origin: string): TenantCode | null {
  try {
    return resolveClientTenantFromHost(new URL(origin).hostname) ?? DEFAULT_CLIENT_TENANT_CODE;
  } catch {
    return null;
  }
}

/** The client app's origin for `site` (USER_APP_URL, in list order), for a link that has to open
 * that site: an emailed link, or the wrong-site screen's button. Null when none is configured. */
export function clientOriginForSite(site: string): string | null {
  return USER_APP_URL.find((origin) => clientSiteOfOrigin(origin) === site) ?? null;
}

/** Strips a trailing `:port` (present on `Host`/`Origin` headers in local dev, e.g.
 * `ph.ilovelawyer.local:3002`) before the exact-match lookup. */
export function resolveTenantCodeFromHost(hostname: string | undefined | null): TenantCode | null {
  if (!hostname) return null;
  const host = hostname.split(":")[0].trim().toLowerCase();
  return HOST_TENANT_CODE_MAP[host] ?? null;
}

/**
 * This API is served from its own host (e.g. api.ilovelawyer.com) — `req.headers.host` always
 * identifies the API, never the tenant's frontend origin, so it's useless for Tenant resolution.
 * Instead, trust the `Origin` header (falling back to `Referer`) that the browser sends on every
 * cross-origin fetch, and resolve *that* hostname. This is what signup and any other endpoint
 * that must derive a Tenant from "which frontend domain is this request really coming from"
 * should use — never a client-supplied `tenantCode`/`jurisdiction` field.
 */
export function resolveTenantCodeFromRequest(req: Request): TenantCode | null {
  const originHeader = req.headers.origin || req.headers.referer;
  if (!originHeader || typeof originHeader !== "string") return null;
  // The client app's hosts are their own map, and any other host it's on is the UK site, as the
  // client app shows it (clientSiteOfOrigin).
  if (resolveClientApp(req) === "user") return clientSiteOfOrigin(originHeader);
  try {
    const url = new URL(originHeader);
    return resolveTenantCodeFromHost(url.hostname);
  } catch {
    return null;
  }
}

/**
 * The absolute frontend origin to use for a given Tenant code's emailed links (approval
 * login-link, password reset, org invites, ...). CLIENT_URL already lists every allowed
 * origin — including each tenant's own hosts (`uk.ilovelawyer.com`, `uk-local.ilovelawyer.com:3002`,
 * ...) — so this just picks the first one whose host HOST_TENANT_CODE_MAP gives to that tenant
 * (list order decides between several), instead of always defaulting to CLIENT_URL[0] (the bare
 * localhost/apex origin). A link built from the wrong origin still resolves once the
 * frontend's own domain-mismatch redirect kicks in (see app/(protected)/layout.tsx), but
 * it should never be the first hop for a tenant-scoped account. Falls back to CLIENT_URL[0]
 * when the tenant is unresolved (e.g. no organization yet) or no matching origin is
 * configured for it.
 */
export function originForTenantCode(tenantCode: string | null | undefined, origins: string[] = CLIENT_URL): string {
  if (tenantCode) {
    const match = origins.find((origin) => {
      try {
        return resolveTenantCodeFromHost(new URL(origin).hostname) === tenantCode;
      } catch {
        return false;
      }
    });
    if (match) return match;
  }
  return origins[0];
}

/** The frontend origin a browser request came from (Origin, falling back to Referer's origin),
 * but only when it's one of the configured CLIENT_URL origins — never an arbitrary
 * client-supplied host, so an emailed link can't be pointed somewhere else. */
export function requestFrontendOrigin(req: Request): string | null {
  const header = req.headers.origin || req.headers.referer;
  if (!header || typeof header !== "string") return null;
  try {
    const origin = new URL(header).origin;
    return CLIENT_URL.includes(origin) ? origin : null;
  } catch {
    return null;
  }
}

/** Where a link emailed in response to the user's own request should point: the frontend they
 * made the request from (same scheme, host and port they're actually using — e.g. the https
 * uk-local dev host rather than the first UK entry in CLIENT_URL), as long as that frontend
 * belongs to the account's Tenant. Otherwise the Tenant's configured origin, as before. */
export function emailLinkOrigin(tenantCode: string | null | undefined, requestOrigin: string | null | undefined): string {
  if (requestOrigin) {
    const requestTenant = resolveTenantCodeFromHost(new URL(requestOrigin).hostname);
    if (!tenantCode || requestTenant === tenantCode) return requestOrigin;
  }
  return originForTenantCode(tenantCode);
}

/** Where a link emailed to `account` should open: the app the account belongs to. A client (USER)
 * account gets the client app on its own site — the origin it asked from when that's a client
 * origin of its site, else its site's first USER_APP_URL, else the first USER_APP_URL — never the
 * lawyer app, which would refuse it (WRONG_APP). Every other account keeps emailLinkOrigin's
 * behaviour. Falls back to emailLinkOrigin when USER_APP_URL is unset, so an environment without
 * the client app behaves exactly as before. */
export function emailLinkOriginForAccount(
  account: { role: Role; tenant?: { code: string } | null } | null,
  requestOrigin: string | null,
): string {
  if (account?.role === "USER" && USER_APP_URL.length > 0) {
    const site = account.tenant?.code ?? DEFAULT_CLIENT_TENANT_CODE;
    if (requestOrigin && USER_APP_URL.includes(requestOrigin) && clientSiteOfOrigin(requestOrigin) === site) return requestOrigin;
    return clientOriginForSite(site) ?? USER_APP_URL[0];
  }
  return emailLinkOrigin(account?.tenant?.code, requestOrigin);
}
