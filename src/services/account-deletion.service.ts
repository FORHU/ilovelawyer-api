import AuthRepo from "../repositories/auth.repository";
import AvatarSvc from "./avatar.service";
import GoogleCalendarSvc from "./google-calendar.service";
import NotificationSvc from "./notification.service";
import { sendEmail } from "../utils/mailer";
import { renderTemplate } from "../utils/template";
import logger from "../utils/logger";

export default class AccountDeletionSvc {
  /** The one place a User row is actually hard-deleted, shared by AccountDeletionQueue (after the
   * self-service grace period) and AdminSvc.deleteUser (immediately). Sends no email — callers
   * that notify the user do so before calling this, while the row and its address still exist. */
  static async purge(userId: string): Promise<void> {
    // Both non-fatal: revoke any Google Calendar grant and flag the avatar File while the
    // User row still points at them.
    await GoogleCalendarSvc.releaseForDeletedUser(userId);
    await AvatarSvc.releaseForDeletedUser(userId);

    await AuthRepo.deleteSessionsByUserId(userId);
    await AuthRepo.deleteUser(userId);
  }

  /** AccountDeletionQueue's variant of purge: re-checks right before touching anything that the
   * request is still due as of `cutoff`, and deletes the row only on that same condition — a user
   * who signed in after the queue read its page (restoreOnSignIn) is skipped. Returns whether the
   * row was deleted. */
  static async purgeIfStillDue(userId: string, cutoff: Date): Promise<boolean> {
    const requestedAt = await AuthRepo.findDeletionRequestedAt(userId);
    if (!requestedAt || requestedAt > cutoff) return false;

    await GoogleCalendarSvc.releaseForDeletedUser(userId);
    await AvatarSvc.releaseForDeletedUser(userId);

    await AuthRepo.deleteSessionsByUserId(userId);
    return AuthRepo.deleteUserIfDeletionDue(userId, cutoff);
  }

  /** Option A of the self-service deletion flow: a completed sign-in during the grace period
   * means the user is keeping their account. Called by every AuthSvc path that issues a session
   * after its checks pass (never by refresh). The DB update is deliberately not caught — signing
   * someone in while their account is still scheduled for deletion is worse than a failed
   * sign-in they can retry. The email and notification are best-effort. */
  static async restoreOnSignIn(user: { id: string; email: string; name: string | null }): Promise<boolean> {
    const restored = await AuthRepo.clearDeletionRequestIfSet(user.id);
    if (!restored) return false;

    try {
      const html = await renderTemplate("account-deletion-restored", { name: user.name || "there" });
      await sendEmail({ to: user.email, subject: "Your ilovelawyer account has been restored", html });
    } catch (err) {
      logger.error("Failed to send account-deletion-restored email", { err, userId: user.id });
    }

    await NotificationSvc.create({
      userId: user.id,
      type: "SYSTEM",
      title: "Your account has been restored",
      message: "Welcome back. You signed in, so your scheduled account deletion was cancelled.",
      link: "/homepage/profile",
    }).catch((err) => logger.error("Failed to create account-restored notification", { err, userId: user.id }));

    return true;
  }
}
