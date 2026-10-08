import bcrypt from "bcrypt";
import AuthRepo from "../repositories/auth.repository";
import HttpError from "../utils/http-error";
import { sendEmail } from "../utils/mailer";
import { renderTemplate } from "../utils/template";
import logger from "../utils/logger";
import { isGoogleSsoAccount } from "../utils/auth.utils";
import { ACCOUNT_DELETION_GRACE_PERIOD_DAYS, accountDeletionDueAt } from "../constants/account-deletion.constants";
import { BCRYPT_SALT_ROUNDS } from "../constants";
import AuditSvc, { AuditAction } from "./audit.service";

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", { dateStyle: "long" });
}

export default class UsersSvc {
  static async getMe(userId: string) {
    const user = await AuthRepo.findById(userId);
    if (!user) throw new HttpError("User not found", 404);
    return user;
  }

  static async updateMe(userId: string, data: { name?: string; username?: string }) {
    if (data.username) {
      const existing = await AuthRepo.findByUsername(data.username);
      if (existing && existing.id !== userId) {
        throw new HttpError("Username is already taken", 409);
      }
    }

    return AuthRepo.updateProfile(userId, data);
  }

  /** Requires the current password (unlike the emailed forgot-password/reset-password flow)
   * since the user is already authenticated here — this is a self-service change, not a
   * recovery from being locked out. Google SSO accounts have no password to change. */
  static async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await AuthRepo.findByIdWithPasswordHash(userId);
    if (!user) throw new HttpError("User not found", 404);
    if (!user.password || isGoogleSsoAccount(user)) throw new HttpError("This account signed in with Google and has no password to change", 400);

    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) throw new HttpError("Current password is incorrect", 400);

    const hashedPassword = await bcrypt.hash(newPassword, BCRYPT_SALT_ROUNDS);
    // changePasswordSchema enforces the current strong-password policy, so this also
    // satisfies mustChangePassword — a legacy user who reaches this endpoint with an
    // active session (e.g. one already open before the flag was ever checked) shouldn't
    // still be walled off by it on their next login.
    await AuthRepo.updatePasswordAndClearMustChange(userId, hashedPassword);
    await AuditSvc.record({ action: AuditAction.PasswordChanged, actorId: userId });
  }

  /** Starts the grace period rather than deleting immediately — see
   * ACCOUNT_DELETION_GRACE_PERIOD_DAYS and AccountDeletionQueue, which performs the eventual
   * hard delete. Every session is revoked: signing back in is how a user keeps their account
   * (AccountDeletionSvc.restoreOnSignIn), so a session left open would sidestep that. The
   * controller clears this request's refresh cookie too.
   *
   * A password account must re-enter its password, same as changePassword — an open session
   * alone isn't enough to schedule a deletion. Google SSO accounts have no password to check. A
   * wrong password is a 400, not a 401, so the client doesn't treat it as an expired session. */
  static async requestDeletion(userId: string, password: string | undefined) {
    const user = await AuthRepo.findById(userId);
    if (!user) throw new HttpError("User not found", 404);
    if (user.deletionRequestedAt) throw new HttpError("Account deletion is already scheduled", 409);

    const credentials = await AuthRepo.findByIdWithPasswordHash(userId);
    if (credentials?.password && !isGoogleSsoAccount(credentials)) {
      if (!password) throw new HttpError("Password is required to delete your account", 400);
      const isValid = await bcrypt.compare(password, credentials.password);
      if (!isValid) throw new HttpError("Password is incorrect", 400);
    }

    const updated = await AuthRepo.setDeletionRequested(userId, new Date());
    await AuthRepo.deleteSessionsByUserId(userId);
    const scheduledFor = accountDeletionDueAt(updated.deletionRequestedAt!);
    await AuditSvc.record({
      action: AuditAction.AccountDeletionRequested,
      actorId: userId,
      payload: { scheduledFor: scheduledFor.toISOString() },
    });

    const html = await renderTemplate("account-deletion-scheduled", {
      name: updated.name || "there",
      scheduledFor: formatDate(scheduledFor),
      gracePeriodDays: String(ACCOUNT_DELETION_GRACE_PERIOD_DAYS),
    });
    await sendEmail({ to: updated.email, subject: "Your ilovelawyer account is scheduled for deletion", html }).catch((err) =>
      logger.error("Failed to send account-deletion-scheduled email", { err, userId }),
    );

    return updated;
  }

  /** Undoes requestDeletion — only valid while the grace period is still running (the row still
   * exists to call this on otherwise). Signing in does the same (restoreOnSignIn); this endpoint
   * remains for a tab whose access token outlived the revoked sessions. */
  static async cancelDeletion(userId: string) {
    const user = await AuthRepo.findById(userId);
    if (!user) throw new HttpError("User not found", 404);
    if (!user.deletionRequestedAt) throw new HttpError("Account deletion is not scheduled", 409);

    const updated = await AuthRepo.setDeletionRequested(userId, null);
    await AuditSvc.record({ action: AuditAction.AccountDeletionCancelled, actorId: userId });

    const html = await renderTemplate("account-deletion-cancelled", { name: updated.name || "there" });
    await sendEmail({ to: updated.email, subject: "Your ilovelawyer account deletion has been cancelled", html }).catch((err) =>
      logger.error("Failed to send account-deletion-cancelled email", { err, userId }),
    );

    return updated;
  }
}
