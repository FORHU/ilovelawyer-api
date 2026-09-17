import bcrypt from "bcrypt";
import AuthRepo from "../repositories/auth.repository";
import HttpError from "../utils/http-error";
import { sendEmail } from "../utils/mailer";
import { renderTemplate } from "../utils/template";
import logger from "../utils/logger";
import { ACCOUNT_DELETION_GRACE_PERIOD_DAYS } from "../constants/account-deletion.constants";
import { BCRYPT_SALT_ROUNDS } from "../constants";

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

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
   * recovery from being locked out. Google-only accounts have no password to change. */
  static async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await AuthRepo.findByIdWithPasswordHash(userId);
    if (!user) throw new HttpError("User not found", 404);
    if (!user.password) throw new HttpError("This account signed in with Google and has no password to change", 400);

    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) throw new HttpError("Current password is incorrect", 400);

    const hashedPassword = await bcrypt.hash(newPassword, BCRYPT_SALT_ROUNDS);
    await AuthRepo.updatePassword(userId, hashedPassword);
  }

  /** Starts the grace period rather than deleting immediately — see
   * ACCOUNT_DELETION_GRACE_PERIOD_DAYS and AccountDeletionQueue, which performs the eventual
   * hard delete. The session stays valid so the user can still cancel from their profile page. */
  static async requestDeletion(userId: string) {
    const user = await AuthRepo.findById(userId);
    if (!user) throw new HttpError("User not found", 404);
    if (user.deletionRequestedAt) throw new HttpError("Account deletion is already scheduled", 409);

    const updated = await AuthRepo.setDeletionRequested(userId, new Date());
    const scheduledFor = addDays(updated.deletionRequestedAt!, ACCOUNT_DELETION_GRACE_PERIOD_DAYS);

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
   * exists to call this on otherwise). */
  static async cancelDeletion(userId: string) {
    const user = await AuthRepo.findById(userId);
    if (!user) throw new HttpError("User not found", 404);
    if (!user.deletionRequestedAt) throw new HttpError("Account deletion is not scheduled", 409);

    const updated = await AuthRepo.setDeletionRequested(userId, null);

    const html = await renderTemplate("account-deletion-cancelled", { name: updated.name || "there" });
    await sendEmail({ to: updated.email, subject: "Your ilovelawyer account deletion has been cancelled", html }).catch((err) =>
      logger.error("Failed to send account-deletion-cancelled email", { err, userId }),
    );

    return updated;
  }
}
