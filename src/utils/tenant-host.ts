import { Request } from "express";
import { TenantCode } from "../types/tenant-code";
import { CLIENT_URL } from "../config";

/**
 * Explicit hostname → Tenant code map. No substring/`.includes()` matching — an unrecognized
 * host always resolves to `null`, never guessed at. Keep in sync with the frontend's copy at
 * ilovelawyer-app/apps/web/lib/jurisdiction/resolve-host.ts (two separate deployables, no
 * shared package between them).
 *
 * Three host conventions are recognized for local dev, all mapping to the same Tenant code:
 * `ph.ilovelawyer.local` (the spec's required form), and the bare `ph.ilovelawyer` this repo's
 * own frontend `next.config.ts` `allowedDevOrigins` already anticipated before this feature was
 * built (what this environment's hosts file actually points at) — plus the `.com` production
 * form, the `-dev.ilovelawyer.com` hosted dev environment, and its `-dev.ilovelawyer.local`
 * local-dev counterpart (`ph-dev.ilovelawyer.com` / `uk-dev.ilovelawyer.com` /
 * `ph-dev.ilovelawyer.local` / `uk-dev.ilovelawyer.local`).
 */
const HOST_TENANT_CODE_MAP: Record<string, TenantCode> = {
  "ph.ilovelawyer.com": "PH",
  "ph-dev.ilovelawyer.com": "PH",
  "ph.ilovelawyer.local": "PH",
  "ph-dev.ilovelawyer.local": "PH",
  "ph.ilovelawyer": "PH",
  "uk.ilovelawyer.com": "UK",
  "uk-dev.ilovelawyer.com": "UK",
  "uk.ilovelawyer.local": "UK",
  "uk-dev.ilovelawyer.local": "UK",
  "uk.ilovelawyer": "UK",
};

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
 * origin — including each tenant's own subdomain (`ph.ilovelawyer.{local:3002,com}`,
 * `uk.ilovelawyer.{local:3002,com}`) — so this just picks the one whose host actually
 * belongs to that tenant, instead of always defaulting to CLIENT_URL[0] (the bare
 * localhost/apex origin). A link built from the wrong origin still resolves once the
 * frontend's own domain-mismatch redirect kicks in (see app/(protected)/layout.tsx), but
 * it should never be the first hop for a tenant-scoped account. Falls back to CLIENT_URL[0]
 * when the tenant is unresolved (e.g. no organization yet) or no matching origin is
 * configured for it.
 */
export function originForTenantCode(tenantCode: string | null | undefined): string {
  if (tenantCode) {
    const prefix = `${tenantCode.toLowerCase()}.`;
    const match = CLIENT_URL.find((origin) => {
      try {
        return new URL(origin).hostname.toLowerCase().startsWith(prefix);
      } catch {
        return false;
      }
    });
    if (match) return match;
  }
  return CLIENT_URL[0];
}
