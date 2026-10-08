/** Every action the security audit log records (docs/adr/0006-security-audit-log.md) — Tier 1 of
 * the audit coverage plan: sign-in, membership and permission changes, admin actions, exports and
 * downloads, deletions. test/security-audit-coverage.spec.ts fails if one of these is never
 * written anywhere in src/, or if a mutating route is neither mapped to one nor exempted. */
export const SECURITY_AUDIT_ACTIONS = [
  // Authentication. auth.login carries payload.method (password, google, google_link, login_link,
  // password_reset, password_update, email_verification) and is written as FAILURE on a refused
  // attempt, with payload.reason.
  "auth.signup",
  "auth.signup_cancelled",
  "auth.login",
  "auth.logout",
  "auth.email_verified",
  "auth.password_reset_requested",
  "auth.password_reset",
  "auth.password_changed",
  "auth.google_linked",

  // The signed-in user's own account
  "account.profile_updated",
  "account.deletion_requested",
  "account.deletion_cancelled",
  "account.purged",
  "integration.connected",
  "integration.disconnected",

  // Organization membership and permissions
  "org.created",
  "org.updated",
  "org.member_invited",
  "org.invite_accepted",
  "org.invite_declined",
  "org.member_role_changed",
  "org.member_removed",
  "org.member_left",
  "org.case_attached",
  "case.access_granted",
  "consultation.invite_created",
  "consultation.invite_accepted",
  "consultation.invite_deleted",
  "consultation.participant_removed",

  // Platform admin actions (ilovelawyer-admin)
  "admin.user.approved",
  "admin.user.denied",
  "admin.user.reactivated",
  "admin.user.blocked",
  "admin.user.unblocked",
  "admin.user.email_verified",
  "admin.user.tenant_changed",
  "admin.user.deleted",
  "admin.settings.signup_auto_approve_changed",
  "admin.model_settings.updated",
  "admin.jurisdiction_module.toggled",

  // Exports and downloads
  "export.case_brief",
  "export.generated_document",
  "export.audit_log",
  "file.accessed",
  "email.sent",

  // Deletions
  "case.deleted",
  "document.deleted",
  "consultation.deleted",
  "consultation.message_deleted",
  "transcription.deleted",
  "note.deleted",
  /** Anything deleted from inside a case (a finding, witness, theory, timeline entry, ...) —
   * written by recordCaseItemDeletions on the case router, payload.route says which kind. */
  "case.item_deleted",
] as const;

export type SecurityAuditAction = (typeof SECURITY_AUDIT_ACTIONS)[number];

export type SecurityAuditTargetType =
  | "user"
  | "organization"
  | "invite"
  | "case"
  | "case_item"
  | "document"
  | "consultation"
  | "message"
  | "transcription"
  | "note"
  | "file"
  | "integration"
  | "tenant"
  | "model_setting"
  | "jurisdiction_module";

/** How long rows are kept before SecurityAuditRetentionQueue deletes them: 7 years by default,
 * overridable with SECURITY_AUDIT_RETENTION_DAYS. Never below the 365-day floor the database
 * trigger enforces (security_audit_event migration) — a shorter setting is raised to it. */
export const SECURITY_AUDIT_RETENTION_FLOOR_DAYS = 365;
const DEFAULT_RETENTION_DAYS = 7 * 365;

export function securityAuditRetentionDays(env: string | undefined = process.env.SECURITY_AUDIT_RETENTION_DAYS): number {
  const parsed = env ? Number.parseInt(env, 10) : NaN;
  const days = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_DAYS;
  return Math.max(days, SECURITY_AUDIT_RETENTION_FLOOR_DAYS);
}

/** Most rows one CSV export of the audit log carries — a firm with more narrows the date range. */
export const SECURITY_AUDIT_EXPORT_MAX_ROWS = 50_000;
export const SECURITY_AUDIT_PAGE_SIZE_MAX = 200;
