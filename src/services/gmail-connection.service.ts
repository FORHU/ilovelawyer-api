import AuthRepo from "../repositories/auth.repository";
import SecurityAuditSvc from "./security-audit.service";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";
import { encryptGoogleToken, isGoogleTokenEncryptionConfigured } from "../utils/google-token-crypto";
import { hasGrantedScope, postGoogleToken, refreshStoredGrant, revokeGoogleTokenQuietly, revokeStoredGrant } from "../utils/google-oauth";

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

function reconnectRequired(): HttpError {
  return new HttpError("Gmail needs to be reconnected", 409, "GMAIL_RECONNECT_REQUIRED");
}

/** Read-only Gmail access for the client app's email import (EPIC #982). Same shape as
 * GoogleCalendarSvc: the client app's auth-code popup hands over a one-time code, and the
 * long-lived refresh token is stored encrypted in User.gmailRefreshToken, separate from the
 * Calendar columns. Any Google account can be connected; it need not be the sign-in account. */
export default class GmailConnectionSvc {
  static async connect(userId: string, code: string) {
    if (!isGoogleTokenEncryptionConfigured()) {
      throw new HttpError("Gmail isn't available on this server", 503, "GMAIL_UNAVAILABLE");
    }

    const { ok, data } = await postGoogleToken({ code, grant_type: "authorization_code", redirect_uri: "postmessage" });
    if (!ok || !data.access_token) {
      throw new HttpError("Google didn't accept the authorization. Try connecting again.", 400);
    }
    if (!hasGrantedScope(data.scope, GMAIL_READONLY_SCOPE)) {
      throw new HttpError("Gmail access wasn't granted. Connect again and allow access to read your email.", 400, "GMAIL_SCOPE_MISSING");
    }

    const profileRes = await fetch(GMAIL_PROFILE_URL, { headers: { Authorization: `Bearer ${data.access_token}` } });
    const profile = (await profileRes.json().catch(() => ({}))) as { emailAddress?: string };
    if (!profileRes.ok || !profile.emailAddress) {
      throw new HttpError("Couldn't reach Gmail. Try connecting again shortly.", 502);
    }

    const existing = await AuthRepo.findGmailTokens(userId);
    const sameMailbox = !!existing?.gmailRefreshToken && existing.gmailEmail?.toLowerCase() === profile.emailAddress.toLowerCase();
    const context = { userId, integration: "gmail" };
    // Google only returns a refresh token on first consent, and withholds one while it still holds
    // an earlier grant for that Google account. The stored token can stand in only for the same
    // mailbox: reusing it for another account would read one inbox while showing another's address.
    // Revoking the new grant makes the next popup a fresh consent, which returns a refresh token.
    if (!data.refresh_token && !sameMailbox) {
      await revokeGoogleTokenQuietly(data.access_token, context);
      throw new HttpError("Google needs you to approve Gmail access again. Click Connect Gmail once more.", 400, "GMAIL_CONSENT_REQUIRED");
    }
    // Switching to a different mailbox: end the old grant rather than leave it live at Google.
    if (existing?.gmailRefreshToken && !sameMailbox) {
      await revokeStoredGrant({ encryptedRefreshToken: existing.gmailRefreshToken, accessToken: existing.gmailAccessToken }, context);
    }

    await AuthRepo.setGmailTokens(userId, {
      accessToken: data.access_token,
      encryptedRefreshToken: data.refresh_token ? encryptGoogleToken(data.refresh_token) : undefined,
      email: profile.emailAddress,
    });
    await SecurityAuditSvc.record({ action: "integration.connected", actorId: userId, targetType: "integration", payload: { type: "gmail" } });
    return AuthRepo.findById(userId);
  }

  /** The last access token minted, if any. GmailMailboxSvc tries it first and only refreshes on a
   * 401, so a burst of calls doesn't mint a token per call. */
  static async storedAccessToken(userId: string): Promise<string | null> {
    const stored = await AuthRepo.findGmailTokens(userId);
    if (!stored?.gmailRefreshToken) {
      throw new HttpError("Gmail isn't connected", 409, "GMAIL_NOT_CONNECTED");
    }
    return stored.gmailAccessToken;
  }

  /** A fresh access token minted from the stored refresh token (and saved). A grant that can't be
   * used any more is cleared with 409 GMAIL_RECONNECT_REQUIRED (see refreshStoredGrant). */
  static async refreshAccessToken(userId: string): Promise<string> {
    const stored = await AuthRepo.findGmailTokens(userId);
    if (!stored?.gmailRefreshToken) {
      throw new HttpError("Gmail isn't connected", 409, "GMAIL_NOT_CONNECTED");
    }
    return refreshStoredGrant(
      { encryptedRefreshToken: stored.gmailRefreshToken, accessToken: stored.gmailAccessToken },
      {
        userId,
        integration: "gmail",
        clear: () => AuthRepo.clearGmailTokens(userId),
        save: (accessToken) => AuthRepo.updateGmailAccessToken(userId, accessToken),
        reconnectRequired,
        unreachable: () => new HttpError("Couldn't reach Gmail. Try again shortly.", 502),
      },
    );
  }

  /** Gmail refused a token that should work (a fresh one rejected, or the grant no longer covers
   * Gmail): end the grant at Google, clear the columns, and return the reconnect error to throw.
   * The app then shows Connect, and that connect is a fresh consent. */
  static async forget(userId: string): Promise<HttpError> {
    const stored = await AuthRepo.findGmailTokens(userId);
    if (stored) {
      await revokeStoredGrant({ encryptedRefreshToken: stored.gmailRefreshToken, accessToken: stored.gmailAccessToken }, { userId, integration: "gmail" });
    }
    await AuthRepo.clearGmailTokens(userId);
    return reconnectRequired();
  }

  /** Revokes the grant at Google and clears the Gmail columns. Google-side failures are logged,
   * not fatal: the user asked to disconnect, so local state always clears.
   *
   * Google revokes per app and Google account, not per scope. If the same Google account also had
   * Calendar connected to this app, this cuts Calendar too. Calendar is connected only from the
   * lawyer app and Gmail only from client accounts, so in practice they don't overlap. */
  static async disconnect(userId: string) {
    const stored = await AuthRepo.findGmailTokens(userId);
    if (stored) {
      await revokeStoredGrant({ encryptedRefreshToken: stored.gmailRefreshToken, accessToken: stored.gmailAccessToken }, { userId, integration: "gmail" });
    }

    await AuthRepo.clearGmailTokens(userId);
    await SecurityAuditSvc.record({ action: "integration.disconnected", actorId: userId, targetType: "integration", payload: { type: "gmail" } });
    return AuthRepo.findById(userId);
  }

  /** AccountDeletionQueue: same as disconnect, never throws. */
  static async releaseForDeletedUser(userId: string): Promise<void> {
    try {
      const stored = await AuthRepo.findGmailTokens(userId);
      if (stored?.gmailRefreshToken || stored?.gmailAccessToken) await GmailConnectionSvc.disconnect(userId);
    } catch (err) {
      logger.error("Failed to disconnect Gmail for deleted user", { err, userId });
    }
  }
}
