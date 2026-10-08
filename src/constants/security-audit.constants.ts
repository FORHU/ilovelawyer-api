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
  "consent.changed",
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

/** Most rows one PDF export of the audit log carries (about 200 pages) — a firm with more narrows
 * the date range or the activity filter. */
export const SECURITY_AUDIT_EXPORT_MAX_ROWS = 5_000;

/** How each action reads in the PDF export. English only, like the rest of the PDFs the API
 * renders; ilovelawyer-app's Organization page translates its own copy (locales/organization.json). */
export const SECURITY_AUDIT_ACTION_LABELS: Record<SecurityAuditAction, string> = {
  "auth.signup": "Signed up",
  "auth.signup_cancelled": "Abandoned signup removed",
  "auth.login": "Sign-in",
  "auth.logout": "Signed out",
  "auth.email_verified": "Email verified",
  "auth.password_reset_requested": "Password reset requested",
  "auth.password_reset": "Password reset",
  "auth.password_changed": "Password changed",
  "auth.google_linked": "Google sign-in connected",
  "account.profile_updated": "Profile updated",
  "account.deletion_requested": "Account deletion requested",
  "account.deletion_cancelled": "Account deletion cancelled",
  "account.purged": "Account deleted",
  "consent.changed": "Consent granted or withdrawn",
  "integration.connected": "Integration connected",
  "integration.disconnected": "Integration disconnected",
  "org.created": "Organization created",
  "org.updated": "Organization details changed",
  "org.member_invited": "Member invited",
  "org.invite_accepted": "Invite accepted",
  "org.invite_declined": "Invite declined",
  "org.member_role_changed": "Member role changed",
  "org.member_removed": "Member removed",
  "org.member_left": "Member left",
  "org.case_attached": "Case moved into organization",
  "case.access_granted": "Case access granted",
  "consultation.invite_created": "Consultation invite created",
  "consultation.invite_accepted": "Consultation invite accepted",
  "consultation.invite_deleted": "Consultation invite revoked",
  "consultation.participant_removed": "Consultation participant removed",
  "admin.user.approved": "Account approved by ilovelawyer",
  "admin.user.denied": "Account denied by ilovelawyer",
  "admin.user.reactivated": "Account reactivated by ilovelawyer",
  "admin.user.blocked": "Account blocked by ilovelawyer",
  "admin.user.unblocked": "Account unblocked by ilovelawyer",
  "admin.user.email_verified": "Email verified by ilovelawyer",
  "admin.user.tenant_changed": "Region changed by ilovelawyer",
  "admin.user.deleted": "Account deleted by ilovelawyer",
  "admin.settings.signup_auto_approve_changed": "Signup auto-approval changed",
  "admin.model_settings.updated": "AI model setting changed",
  "admin.jurisdiction_module.toggled": "Jurisdiction module switched",
  "export.case_brief": "Case brief exported",
  "export.generated_document": "Document generated",
  "export.audit_log": "Audit log exported",
  "file.accessed": "File opened or downloaded",
  "email.sent": "Email sent through ilovelawyer",
  "case.deleted": "Case deleted",
  "document.deleted": "Document deleted",
  "consultation.deleted": "Consultation deleted",
  "consultation.message_deleted": "Consultation message deleted",
  "transcription.deleted": "Transcription deleted",
  "note.deleted": "Note deleted",
  "case.item_deleted": "Item deleted from a case",
};
/** Rows per page of the audit log list — the app shows 20 at a time and never asks for more. */
export const SECURITY_AUDIT_PAGE_SIZE_MAX = 20;
