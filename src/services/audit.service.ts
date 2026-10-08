import OrganizationRepo from "../repositories/organization.repository";
import logger from "../utils/logger";

/** Security-relevant events recorded through AuditSvc. Case-workspace edits ("claim.create",
 * "theory.fork", …) predate this list and still call OrganizationRepo.writeAudit directly. */
export const AuditAction = {
  LoginSucceeded: "auth.login",
  LoginFailed: "auth.login_failed",
  LoggedOut: "auth.logout",
  PasswordChanged: "auth.password_changed",
  AccountDeletionRequested: "account.deletion_requested",
  AccountDeletionCancelled: "account.deletion_cancelled",
  AccountRestoredOnSignIn: "account.restored_on_sign_in",
  AccountPurged: "account.purged",
  AccountDataExported: "account.data_export",
  FileDownloaded: "file.download",
  DocumentDeleted: "document.delete",
  CaseBriefExported: "case.brief_export",
  GeneratedDocumentExported: "document.generated_export",
  OrgInviteSent: "org.invite",
  OrgInviteAccepted: "org.invite_accepted",
  OrgInviteDeclined: "org.invite_declined",
  OrgMemberRoleChanged: "org.member_role_changed",
  OrgMemberRemoved: "org.member_removed",
  OrgMemberLeft: "org.member_left",
} as const;

export type AuditActionName = (typeof AuditAction)[keyof typeof AuditAction];

const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|api[-_]?key/i;
const MAX_DEPTH = 5;

/** Replaces the value of any key that looks like a credential, at any depth, so a caller that
 * passes a whole request body or error object can't leak a password or token into the trail. */
export function scrubAuditPayload(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.map((item) => scrubAuditPayload(item, depth + 1));
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, v]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[redacted]" : scrubAuditPayload(v, depth + 1),
      ]),
    );
  }
  return value;
}

export default class AuditSvc {
  /** Appends one row to the audit trail. Never throws: a failure to write the trail is logged and
   * swallowed so it can't break the action being audited. Callers must not put document content
   * or other free text in `payload` — ids, counts and short reasons only. */
  static async record(event: { action: AuditActionName; actorId?: string; caseId?: string; payload?: Record<string, unknown> }) {
    try {
      await OrganizationRepo.writeAudit({
        action: event.action,
        actorId: event.actorId,
        caseId: event.caseId,
        payload: event.payload ? (scrubAuditPayload(event.payload) as object) : undefined,
      });
    } catch (err) {
      logger.error("Failed to write audit event", { err, action: event.action });
    }
  }
}
