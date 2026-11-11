import AuthRepo from "../repositories/auth.repository";
import SecurityAuditSvc from "./security-audit.service";
import CalendarWatchChannelRepo from "../repositories/calendar-watch-channel.repository";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";
import { encryptGoogleToken, isGoogleTokenEncryptionConfigured } from "../utils/google-token-crypto";
import { hasGrantedScope, postGoogleToken as postToken, refreshStoredGrant, revokeStoredGrant } from "../utils/google-oauth";

const CHANNEL_STOP_URL = "https://www.googleapis.com/calendar/v3/channels/stop";
export const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";

function reconnectRequired(): HttpError {
  return new HttpError("Google Calendar needs to be reconnected", 409, "GOOGLE_CALENDAR_RECONNECT_REQUIRED");
}

/** Google Calendar access, kept apart from sign-in on purpose: signing in with Google never
 * stores a token or asks for Calendar. A user opts in from their profile (any Google account),
 * the app's auth-code popup hands this service a one-time code, and the long-lived refresh token
 * is stored encrypted in User.googleRefreshToken. Nothing here touches `provider`, which decides
 * who may sign in with a password (see isGoogleSsoAccount). */
export default class GoogleCalendarSvc {
  static async connect(userId: string, code: string) {
    if (!isGoogleTokenEncryptionConfigured()) {
      throw new HttpError("Google Calendar isn't available on this server", 503);
    }

    // `postmessage` is the redirect_uri Google's popup (GIS auth-code flow) codes are bound to.
    const { ok, data } = await postToken({ code, grant_type: "authorization_code", redirect_uri: "postmessage" });
    if (!ok || !data.access_token) {
      throw new HttpError("Google didn't accept the authorization. Try connecting again.", 400);
    }
    // Granular consent lets the user untick Calendar and still finish the popup.
    if (!hasGrantedScope(data.scope, GOOGLE_CALENDAR_SCOPE)) {
      throw new HttpError("Calendar access wasn't granted. Connect again and allow calendar access.", 400, "GOOGLE_CALENDAR_SCOPE_MISSING");
    }

    const existing = await AuthRepo.findGoogleCalendarTokens(userId);
    // Google only returns a refresh token on first consent for this app. disconnect() revokes the
    // grant, so a reconnect is a fresh consent; a missing one with nothing stored is unusable.
    if (!data.refresh_token && !existing?.googleRefreshToken) {
      throw new HttpError("Google didn't grant offline access. Try connecting again.", 400);
    }

    await AuthRepo.setGoogleCalendarTokens(userId, {
      accessToken: data.access_token,
      encryptedRefreshToken: data.refresh_token ? encryptGoogleToken(data.refresh_token) : undefined,
    });
    await SecurityAuditSvc.record({ action: "integration.connected", actorId: userId, targetType: "integration", payload: { type: "google_calendar" } });
    return AuthRepo.findById(userId);
  }

  /** A fresh access token minted from the stored refresh token (and saved). A grant that can't be
   * used any more is cleared with 409 GOOGLE_CALENDAR_RECONNECT_REQUIRED (see refreshStoredGrant). */
  static async getAccessToken(userId: string): Promise<string> {
    const stored = await AuthRepo.findGoogleCalendarTokens(userId);
    if (!stored?.googleRefreshToken) {
      throw new HttpError("Google Calendar isn't connected", 409, "GOOGLE_CALENDAR_NOT_CONNECTED");
    }
    return refreshStoredGrant(
      { encryptedRefreshToken: stored.googleRefreshToken, accessToken: stored.googleAccessToken },
      {
        userId,
        integration: "google_calendar",
        clear: () => AuthRepo.clearGoogleCalendarTokens(userId),
        save: (accessToken) => AuthRepo.updateGoogleAccessToken(userId, accessToken),
        reconnectRequired,
        unreachable: () => new HttpError("Couldn't reach Google Calendar. Try again shortly.", 502),
      },
    );
  }

  /** Stops the Calendar watch, revokes the grant at Google and clears both columns. Google-side
   * failures are logged, not fatal: the user asked to disconnect, so local state always clears. */
  static async disconnect(userId: string) {
    const stored = await AuthRepo.findGoogleCalendarTokens(userId);

    const channel = await CalendarWatchChannelRepo.findForUser(userId);
    if (channel && stored?.googleAccessToken) {
      await fetch(CHANNEL_STOP_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${stored.googleAccessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ id: channel.channelId, resourceId: channel.resourceId }),
      }).catch((err) => logger.error("Failed to stop Google Calendar watch channel", { err, userId }));
    }
    await CalendarWatchChannelRepo.deleteForUser(userId);

    // Revoking the refresh token also revokes every access token minted from it.
    await revokeStoredGrant(
      stored ? { encryptedRefreshToken: stored.googleRefreshToken, accessToken: stored.googleAccessToken } : null,
      { userId, integration: "google_calendar" },
    );

    await AuthRepo.clearGoogleCalendarTokens(userId);
    await SecurityAuditSvc.record({ action: "integration.disconnected", actorId: userId, targetType: "integration", payload: { type: "google_calendar" } });
    return AuthRepo.findById(userId);
  }

  /** AccountDeletionQueue: same as disconnect, never throws. */
  static async releaseForDeletedUser(userId: string): Promise<void> {
    try {
      const stored = await AuthRepo.findGoogleCalendarTokens(userId);
      if (stored?.googleRefreshToken || stored?.googleAccessToken) await GoogleCalendarSvc.disconnect(userId);
    } catch (err) {
      logger.error("Failed to disconnect Google Calendar for deleted user", { err, userId });
    }
  }
}
