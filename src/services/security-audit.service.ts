import { Prisma, SecurityAuditEvent, SecurityAuditOutcome } from "@prisma/client";
import SecurityAuditRepo, { SecurityAuditFilter } from "../repositories/security-audit.repository";
import { getRequestContext } from "../lib/request-context";
import {
  SECURITY_AUDIT_EXPORT_MAX_ROWS,
  SecurityAuditAction,
  SecurityAuditTargetType,
} from "../constants/security-audit.constants";
import { renderAuditLogPdf } from "../utils/audit-log-pdf-renderer";
import { describeAuditEvent, loadNames } from "./security-audit-describe";
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
  /** The target's name, for a target this action is deleting — once it's gone the log can't look
   * it up. Leave unset for anything that will still exist. */
  targetName?: string | null;
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
      targetName: input.targetName ?? null,
      caseId: input.caseId ?? null,
      ip: context?.ip ?? null,
      userAgent: context?.userAgent ?? null,
      requestId: context?.requestId ?? null,
      payload: Object.keys(payload).length ? (payload as Prisma.InputJsonObject) : undefined,
    };
  }

  /** One page of the log, newest first (pages count from 1), with the totals the app's
   * pagination needs. Each event carries `display`: who, what was affected and the details, named
   * and in plain words (security-audit-describe.ts) — what the app shows instead of ids. */
  static async list(filter: SecurityAuditFilter, page: number, pageSize: number) {
    const [rows, total] = await Promise.all([
      SecurityAuditRepo.list(filter, pageSize, (page - 1) * pageSize),
      SecurityAuditRepo.count(filter),
    ]);
    const names = await loadNames(rows);
    const events = rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      action: row.action,
      outcome: row.outcome,
      requestId: row.requestId,
      display: describeAuditEvent(row, names),
    }));
    return { events, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  }

  /** The filtered log as a PDF table, newest first, capped at SECURITY_AUDIT_EXPORT_MAX_ROWS. The
   * export itself is recorded (export.audit_log), after the rows it covers were read. */
  static async exportPdf(filter: SecurityAuditFilter, scope: string): Promise<{ pdf: Buffer; rowCount: number; truncated: boolean }> {
    const total = await SecurityAuditRepo.count(filter);
    const wanted = Math.min(total, SECURITY_AUDIT_EXPORT_MAX_ROWS);
    const events: SecurityAuditEvent[] = [];
    while (events.length < wanted) {
      const take = Math.min(1000, wanted - events.length);
      const rows = await SecurityAuditRepo.list(filter, take, events.length);
      events.push(...rows);
      if (rows.length < take) break;
    }
    const truncated = total > events.length;

    const context = getRequestContext();
    const generatedById = context?.userId();
    const generatedBy = generatedById ? ((await SecurityAuditRepo.findUserAuditInfo(generatedById))?.email ?? null) : null;
    const names = await loadNames(events);
    const pdf = await renderAuditLogPdf(
      {
        scope,
        generatedAt: new Date(),
        generatedBy,
        filters: Object.entries(describeFilter(filter)).map(([key, value]) => `${key}: ${value}`),
        rowCount: total,
        truncated,
        maxRows: SECURITY_AUDIT_EXPORT_MAX_ROWS,
      },
      events.map((event) => ({ event, display: describeAuditEvent(event, names) })),
    );

    await SecurityAuditSvc.record({
      action: "export.audit_log",
      ...(filter.organizationId !== undefined && { organizationId: filter.organizationId }),
      targetType: filter.organizationId ? "organization" : undefined,
      targetId: filter.organizationId ?? null,
      payload: { format: "pdf", rowCount: events.length, truncated, filter: describeFilter(filter) },
    });
    return { pdf, rowCount: events.length, truncated };
  }
}

function describeFilter(filter: SecurityAuditFilter): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(filter)) {
    // sort/order arrange the rows rather than narrow them, so they aren't listed as filters.
    if (value === undefined || value === null || ["organizationId", "sort", "order"].includes(key)) continue;
    out[key] = value instanceof Date ? value.toISOString() : String(value);
  }
  return out;
}
