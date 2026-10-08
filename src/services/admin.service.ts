import crypto from "crypto";
import AuthRepo from "../repositories/auth.repository";
import OrganizationMemberRepo from "../repositories/organization-member.repository";
import TenantRepo from "../repositories/tenant.repository";
import AuditEventRepo, { type ListAuditEventsParams } from "../repositories/audit-event.repository";
import AccountDeletionSvc from "./account-deletion.service";
import AuthSvc from "./auth.service";
import SecurityAuditSvc from "./security-audit.service";
import type { TenantCode } from "../types/tenant-code";
import HttpError from "../utils/http-error";
import { sendEmail } from "../utils/mailer";
import { renderTemplate } from "../utils/template";
import { originForTenantCode } from "../utils/tenant-host";
import { redis } from "../lib/redis";
import { ListUsersParams } from "../types/admin.types";
import { USERS_LIST_CACHE_TTL_S, USERS_LIST_VERSION_KEY, TRANSITIONS, LOGIN_LINK_EXPIRY_MS } from "../constants";
import type { SecurityAuditAction } from "../constants/security-audit.constants";

const TRANSITION_AUDIT_ACTIONS: Record<keyof typeof TRANSITIONS, SecurityAuditAction> = {
  approve: "admin.user.approved",
  deny: "admin.user.denied",
  reactivate: "admin.user.reactivated",
  block: "admin.user.blocked",
  unblock: "admin.user.unblocked",
};

export default class AdminSvc {
  /** Cached per page under a version number that AuthRepo bumps on every user write that changes
   * what this list shows (see bustUsersList there) — so no caller has to remember to. */
  static async listUsers(params: ListUsersParams) {
    const version = (await redis.get<number>(USERS_LIST_VERSION_KEY)) ?? 0;
    const cacheKey = `admin:users:v${version}:${JSON.stringify(params)}`;

    const cached = await redis.get<{ data: unknown; total: number }>(cacheKey);
    if (cached) return cached;

    const result = await AuthRepo.listUsers(params);
    await redis.set(cacheKey, result, USERS_LIST_CACHE_TTL_S);
    return result;
  }

  /** Not cached: the audit trail is read rarely and is expected to be current. */
  static async listAuditEvents(params: ListAuditEventsParams) {
    return AuditEventRepo.list(params);
  }

  /** Throws 404 unless this is a regular user's account. Like the user list, the export tools
   * manage regular accounts, not other admins. */
  static async assertExportable(userId: string) {
    const user = await AuthRepo.findById(userId);
    if (!user || user.role !== "USER") throw new HttpError("User not found", 404);
  }

  /** `adminId` defaults to the signed-in admin of the current request (SecurityAuditSvc); the bulk
   * approval runner passes it, since it keeps going after that request has answered. */
  private static async transition(action: keyof typeof TRANSITIONS, userId: string, reason?: string, adminId?: string) {
    const spec = TRANSITIONS[action];
    const user = await AuthRepo.findById(userId);
    if (!user) throw new HttpError("User not found", 404);

    if (user.approvalStatus !== spec.from) {
      throw new HttpError(
        `Cannot ${action}: account is ${user.approvalStatus}, not ${spec.from}`,
        409
      );
    }

    const updated = await AuthRepo.setApprovalStatus(userId, spec.to, spec.to === "DENIED" ? (reason ?? null) : null);

    // Any approvalStatus change invalidates whatever session the user is currently holding —
    // otherwise a stale refresh-token cookie from before this transition keeps silently
    // re-authenticating them (e.g. an approved-but-not-yet-refreshed PENDING session slipping
    // straight into the app once approvalStatus flips to ACTIVE). Applies uniformly to every
    // transition, not just approve.
    await AuthRepo.deleteSessionsByUserId(userId);
    await SecurityAuditSvc.record({
      action: TRANSITION_AUDIT_ACTIONS[action],
      ...(adminId && { actorId: adminId }),
      targetType: "user",
      targetId: userId,
      payload: { from: spec.from, to: spec.to, ...(spec.to === "DENIED" && reason ? { hasReason: true } : {}) },
    });

    let loginLink = "";
    if (spec.includeLoginLink) {
      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + LOGIN_LINK_EXPIRY_MS);
      await AuthRepo.setLoginLinkToken(userId, token, expiresAt);
      // A tenant-scoped account's login link should land on its own subdomain (uk./ph.), not
      // the bare CLIENT_URL[0] — see originForTenantCode. Unresolved (no org yet) falls back
      // to CLIENT_URL[0] there.
      const membership = await OrganizationMemberRepo.findAnyForUser(userId);
      const origin = originForTenantCode(membership?.organization.tenant.code);
      loginLink = `${origin}/login-link?token=${token}`;
    }

    const html = await renderTemplate(spec.template, { name: user.name || "there", reason: reason ?? "", loginLink });
    await sendEmail({ to: user.email, subject: spec.subject, html });

    return updated;
  }

  static async approve(userId: string, adminId?: string) {
    return AdminSvc.transition("approve", userId, undefined, adminId);
  }

  static async deny(userId: string, reason?: string) {
    return AdminSvc.transition("deny", userId, reason);
  }

  static async reactivate(userId: string) {
    return AdminSvc.transition("reactivate", userId);
  }

  static async block(userId: string) {
    return AdminSvc.transition("block", userId);
  }

  static async unblock(userId: string) {
    return AdminSvc.transition("unblock", userId);
  }

  /** Marks a user's email verified on an admin's say-so, in place of the signup OTP — for someone
   * whose code never arrives, say. Does what AuthSvc.verifyOtp does at that moment (clears the
   * pending code, auto-approves a PENDING user when their Tenant has auto-approve on) minus the
   * login itself. No session wipe — an unverified user can't have logged in — and no email: they
   * can simply sign in now. One-way on purpose: un-verifying would lock a user out mid-session. */
  static async verifyEmail(userId: string, adminId: string) {
    const user = await AuthRepo.findById(userId);
    if (!user) throw new HttpError("User not found", 404);
    if (user.isEmailVerified) throw new HttpError("Email is already verified", 409);

    const verified = await AuthRepo.markEmailVerified(userId);
    const autoApproved = await AuthSvc.autoApproveIfEnabled(verified);

    await SecurityAuditSvc.record({
      action: "admin.user.email_verified",
      actorId: adminId,
      targetType: "user",
      targetId: userId,
      payload: { autoApproved },
    });
    return AuthRepo.findById(userId);
  }

  /** Moves a user to another Tenant — e.g. an account created from an unresolved origin
   * (tenantId null), or one that signed up on the wrong regional site. User.tenantId decides
   * which Tenant's auto-approve switch and "Approve all pending" run apply to them; sign-in
   * access is decided by their Organization's Tenant instead (AuthSvc.assertTenantAccess), so
   * a user who already belongs to an Organization can only be set to that Organization's
   * Tenant — anything else would leave the two disagreeing. No-op if already there. */
  static async changeTenant(userId: string, code: TenantCode, adminId: string) {
    const user = await AuthRepo.findTenantById(userId);
    if (!user) throw new HttpError("User not found", 404);

    const tenantId = await TenantRepo.findIdByCode(code);
    if (!tenantId) throw new HttpError(`Unknown tenant ${code}`, 404);

    const membership = await OrganizationMemberRepo.findAnyForUser(userId);
    const orgTenant = membership?.organization.tenant.code;
    if (orgTenant && orgTenant !== code) {
      throw new HttpError(
        `This user belongs to an organization in the ${orgTenant} tenant, so their tenant can't be changed to ${code}.`,
        409,
      );
    }

    const updated = await AuthRepo.setTenant(userId, tenantId);
    if (user.tenantId !== tenantId) {
      await SecurityAuditSvc.record({
        action: "admin.user.tenant_changed",
        actorId: adminId,
        targetType: "user",
        targetId: userId,
        payload: { from: user.tenant?.code ?? null, to: code },
      });
    }
    return updated;
  }

  /** Hard-deletes a user immediately, whatever their approvalStatus — unlike the self-service
   * UsersSvc.requestDeletion, there is no grace period, no undo and no email to the user. Admin
   * accounts (including the caller's own) are refused: the admin list only manages USER rows.
   * The audit row keeps the email, since the User row is gone once this returns. */
  static async deleteUser(userId: string, adminId: string) {
    const user = await AuthRepo.findById(userId);
    if (!user) throw new HttpError("User not found", 404);
    if (userId === adminId) throw new HttpError("You can't delete your own account", 403);
    if (user.role === "ADMIN") throw new HttpError("Admin accounts can't be deleted here", 403);

    // Read before the purge: the membership goes with the user row, and the firm should still see
    // that its member was deleted.
    const membership = await OrganizationMemberRepo.findAnyForUser(userId);
    await AccountDeletionSvc.purge(userId);

    await SecurityAuditSvc.record({
      action: "admin.user.deleted",
      actorId: adminId,
      organizationId: membership?.organizationId ?? null,
      targetType: "user",
      targetId: userId,
      targetName: user.name ?? user.email,
      payload: { email: user.email },
    });
  }
}
