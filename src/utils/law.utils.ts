import { Request } from "express";
import HttpError from "./http-error";
import { getTenantContext } from "./tenant-context";
import { TenantCode } from "../types/tenant-code";

/** Citation Map covers PH (juris.ph) and UK (UK Legal MCP) — every other tenantCode gets a 501.
 * Unlike Law Search (still PH-only pending a UK corpus), Citation Map's UK path needs no ingested
 * corpus of its own — it calls the UK Legal MCP directly per citation, so it's available today. */
export function assertCitationsAvailable(req: Request): TenantCode {
  const { tenantCode } = getTenantContext(req);
  if (tenantCode !== "PH" && tenantCode !== "UK") {
    throw new HttpError("Citation Map is not available for this jurisdiction — coming soon", 501);
  }
  return tenantCode;
}
