import type { TenantCode } from "../types/tenant-code";
import { caseSummaryFilename } from "./client-case-summary-document";

/** A document's entry name inside the client's case export ZIP: `documents/<8 chars of its id>-<name>`.
 * The id prefix keeps two uploads with the same filename from colliding; the name itself is
 * stripped of path separators and control characters, the same rule as DataExportSvc's safeFileName. */
export function safeDocumentEntryName(id: string, name: string | null): string {
  const cleaned = (name ?? "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return `documents/${id.slice(0, 8)}-${(cleaned || "document").slice(0, 150)}`;
}

/** case-export-<title>-<YYYY-MM-DD>.zip, the same slugging and dating rule as caseSummaryFilename. */
export function caseBundleFilename(title: string, now: Date, tenantCode: TenantCode): string {
  return caseSummaryFilename(title, now, tenantCode).replace(/^case-summary-/, "case-export-").replace(/\.pdf$/, ".zip");
}
