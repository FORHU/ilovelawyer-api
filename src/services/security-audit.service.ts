import { Prisma, SecurityAuditEvent, SecurityAuditOutcome } from "@prisma/client";
import SecurityAuditRepo, { SecurityAuditFilter } from "../repositories/security-audit.repository";
import { getRequestContext } from "../lib/request-context";
import {
  SECURITY_AUDIT_EXPORT_MAX_ROWS,
  SecurityAuditAction,
  SecurityAuditTargetType,
} from "../constants/security-audit.constants";
import { normalizeEmail } from "../utils/auth.utils";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";

export interface SecurityAuditInput {
  action: SecurityAuditAction;
  outcome?: SecurityAuditOutcome;
  /** Defaults to the signed-in user of the current request. Pass null for "nobody signed in". */
  actorId?: string | null;
  /** Defaults to the request's resolved organization, then the actor's, then the target user's.
   * Pass it explicitly when the organization is about to stop being findable (a member removed,
   * an account purged). */
  organizationId?: string | null;
  targetType?: SecurityAuditTargetType;
  targetId?: string | null;
  caseId?: string | null;
  /** Ids, counts, field names, reasons — never case content (rows outlive the case). */
  payload?: Record<string, unknown>;
  /** A sign-in attempt's typed email: kept in the payload, and resolved to the account it names
   * (as the target) so a firm sees failed attempts against its members. */
  attemptedEmail?: string;
}

/** A refused attempt's reason as the API told the caller — HttpError messages are already
 * written to be safe to show; anything else is an internal error and says only that. */
function failureReason(err: unknown): { reason: string; status?: number } {
  if (err instanceof HttpError) return { reason: err.message, status: err.statusCode };
  return { reason: "internal_error" };
}

export default class SecurityAuditSvc {
  /** Writes one security audit row. Never throws: a failed write must not undo or fail the action
   * it describes (which has already happened), so it is logged at error level with the whole row
   * instead — error.log is the fallback record. Awaited by callers so the row exists by the time
   * the response goes out. */
  static async record(input: SecurityAuditInput): Promise<void> {
    let row: Prisma.SecurityAuditEventUncheckedCreateInput | undefined;
    try {
      row = await SecurityAuditSvc.buildRow(input);
      await SecurityAuditRepo.create(row);
    } catch (err) {
      logger.error("Security audit: failed to write event", { err, event: row ?? input });
    }
  }

  /** record() for an attempt that was refused — outcome FAILURE, with the refusal's reason. */
  static async recordFailure(input: Omit<SecurityAuditInput, "outcome">, err: unknown): Promise<void> {
    await SecurityAuditSvc.record({ ...input, outcome: "FAILURE", payload: { ...input.payload, ...failureReason(err) } });
  }

  private static async buildRow(input: SecurityAuditInput): Promise<Prisma.SecurityAuditEventUncheckedCreateInput> {
    const context = getRequestContext();
    const actorId = input.actorId !== undefined ? input.actorId : (context?.userId() ?? null);

    let { targetType, targetId } = input;
    const payload: Record<string, unknown> = { ...input.payload };
    if (input.attemptedEmail) {
      const email = normalizeEmail(input.attemptedEmail);
      payload.email = email;
      if (!targetId) {
        const userId = await SecurityAuditRepo.findUserIdByEmail(email);
        if (userId) {
          targetType = "user";
          targetId = userId;
        }
      }
    }

    const actor = actorId ? await SecurityAuditRepo.findUserAuditInfo(actorId) : null;
    const actorMembership = actor?.organizationMemberships[0];

    let organizationId: string | null = null;
    let tenantCode: string | null = null;
    if (input.organizationId !== undefined) {
      organizationId = input.organizationId;
    } else if (context?.organizationId()) {
      organizationId = context.organizationId();
      tenantCode = context.tenantCode();
    } else if (actorMembership) {
      organizationId = actorMembership.organizationId;
      tenantCode = actorMembership.organization.tenant.code;
    } else if (targetType === "user" && targetId) {
      const membership = (await SecurityAuditRepo.findUserAuditInfo(targetId))?.organizationMemberships[0];
      organizationId = membership?.organizationId ?? null;
      tenantCode = membership?.organization.tenant.code ?? null;
    }
    if (organizationId && !tenantCode) tenantCode = await SecurityAuditRepo.findOrganizationTenantCode(organizationId);

    return {
      action: input.action,
      outcome: input.outcome ?? "SUCCESS",
      organizationId,
      tenantCode,
      actorId,
      actorEmail: actor?.email ?? null,
      targetType: targetType ?? null,
      targetId: targetId ?? null,
      caseId: input.caseId ?? null,
      ip: context?.ip ?? null,
      userAgent: context?.userAgent ?? null,
      requestId: context?.requestId ?? null,
      payload: Object.keys(payload).length ? (payload as Prisma.InputJsonObject) : undefined,
    };
  }

  /** One page of the log, newest first, plus the cursor for the next page (null at the end). */
  static async list(filter: SecurityAuditFilter, limit: number, cursor?: string) {
    const rows = await SecurityAuditRepo.list(filter, limit + 1, cursor);
    const page = rows.slice(0, limit);
    return { events: page, nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null };
  }

  /** The filtered log as CSV, newest first, capped at SECURITY_AUDIT_EXPORT_MAX_ROWS. The export
   * itself is recorded (export.audit_log). */
  static async exportCsv(filter: SecurityAuditFilter): Promise<{ csv: string; rowCount: number; truncated: boolean }> {
    const lines = [CSV_COLUMNS.join(",")];
    let cursor: string | undefined;
    let rowCount = 0;
    let truncated = false;
    for (;;) {
      const rows = await SecurityAuditRepo.list(filter, 1000, cursor);
      for (const row of rows) {
        if (rowCount === SECURITY_AUDIT_EXPORT_MAX_ROWS) {
          truncated = true;
          break;
        }
        lines.push(toCsvLine(row));
        rowCount++;
      }
      if (truncated || rows.length < 1000) break;
      cursor = rows.at(-1)!.id;
    }

    await SecurityAuditSvc.record({
      action: "export.audit_log",
      ...(filter.organizationId !== undefined && { organizationId: filter.organizationId }),
      targetType: filter.organizationId ? "organization" : undefined,
      targetId: filter.organizationId ?? null,
      payload: { rowCount, truncated, filter: describeFilter(filter) },
    });
    return { csv: lines.join("\r\n") + "\r\n", rowCount, truncated };
  }
}

const CSV_COLUMNS = [
  "createdAt",
  "action",
  "outcome",
  "actorEmail",
  "actorId",
  "targetType",
  "targetId",
  "caseId",
  "organizationId",
  "ip",
  "userAgent",
  "requestId",
  "payload",
] as const;

/** RFC 4180 quoting, plus a leading ' on anything a spreadsheet would run as a formula — a user
 * agent or typed email is attacker-controlled and this file is meant to be opened in Excel. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = value instanceof Date ? value.toISOString() : typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsvLine(row: SecurityAuditEvent): string {
  return CSV_COLUMNS.map((column) => csvCell(row[column])).join(",");
}

function describeFilter(filter: SecurityAuditFilter): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined || value === null || key === "organizationId") continue;
    out[key] = value instanceof Date ? value.toISOString() : String(value);
  }
  return out;
}
