import { Request } from "express";
import { TenantCode } from "../types/tenant-code";

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
 * form.
 */
const HOST_TENANT_CODE_MAP: Record<string, TenantCode> = {
  "ph.ilovelawyer.com": "PH",
  "ph.ilovelawyer.local": "PH",
  "ph.ilovelawyer": "PH",
  "uk.ilovelawyer.com": "UK",
  "uk.ilovelawyer.local": "UK",
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
