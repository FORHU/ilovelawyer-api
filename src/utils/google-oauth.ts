import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } from "../config";
import HttpError from "./http-error";
import logger from "./logger";
import { decryptGoogleToken } from "./google-token-crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  error?: string;
}

/** Google's token endpoint with our client credentials: an auth-code exchange (`grant_type:
 * "authorization_code"`, `redirect_uri: "postmessage"` for the GIS popup) or a refresh. Shared by
 * GoogleCalendarSvc and GmailConnectionSvc. */
export async function postGoogleToken(params: Record<string, string>): Promise<{ ok: boolean; data: GoogleTokenResponse }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, ...params }),
  });
  const data = (await res.json().catch(() => ({}))) as GoogleTokenResponse;
  return { ok: res.ok, data };
}

/** Revokes a token at Google. Revoking a refresh token also revokes every access token minted
 * from it. Throws on a network failure; callers log it and carry on clearing local state. */
export async function revokeGoogleToken(token: string): Promise<void> {
  await fetch(REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  });
}

/** Whether Google's space-separated granted-scope string includes `scope`. With granular consent
 * the user can untick a scope and still finish the popup. */
export function hasGrantedScope(granted: string | undefined, scope: string): boolean {
  return !!granted?.split(" ").includes(scope);
}

/** Revokes a token at Google, logging rather than throwing on failure. */
export async function revokeGoogleTokenQuietly(token: string, context: { userId: string; integration: string }): Promise<void> {
  await revokeGoogleToken(token).catch((err) => logger.error("Failed to revoke Google token", { err, ...context }));
}

/** A grant as stored on the User row: the encrypted refresh token and the last access token. */
export interface StoredGoogleGrant {
  encryptedRefreshToken: string | null;
  accessToken: string | null;
}

/** Ends a stored grant at Google (the refresh token if it decrypts, else the last access token),
 * quietly. Revoking either one ends the whole grant, so the next connect is a fresh consent and
 * Google returns a new refresh token. */
export async function revokeStoredGrant(stored: StoredGoogleGrant | null, context: { userId: string; integration: string }): Promise<void> {
  const refreshToken = stored?.encryptedRefreshToken ? decryptGoogleToken(stored.encryptedRefreshToken) : null;
  const toRevoke = refreshToken ?? stored?.accessToken;
  if (toRevoke) await revokeGoogleTokenQuietly(toRevoke, context);
}

/**
 * A fresh access token minted from a stored grant, shared by GoogleCalendarSvc and
 * GmailConnectionSvc. A grant that can no longer be used is cleared and `reconnectRequired` is
 * thrown, so the app shows Reconnect instead of a dead state:
 * - an undecryptable refresh token (key rotated or misconfigured): the grant is also revoked
 *   with the last access token, since Google withholds a new refresh token while it still holds
 *   the old grant, and the reconnect would fail.
 * - `invalid_grant` (revoked or expired at Google): nothing left to revoke.
 * Any other failure is temporary and keeps the grant.
 */
export async function refreshStoredGrant(
  stored: StoredGoogleGrant,
  options: {
    userId: string;
    integration: string;
    clear: () => Promise<unknown>;
    save: (accessToken: string) => Promise<unknown>;
    reconnectRequired: () => HttpError;
    unreachable: () => HttpError;
  },
): Promise<string> {
  const context = { userId: options.userId, integration: options.integration };
  const refreshToken = stored.encryptedRefreshToken ? decryptGoogleToken(stored.encryptedRefreshToken) : null;
  if (!refreshToken) {
    logger.warn("Stored Google refresh token could not be decrypted; clearing it", context);
    if (stored.accessToken) await revokeGoogleTokenQuietly(stored.accessToken, context);
    await options.clear();
    throw options.reconnectRequired();
  }

  const { ok, data } = await postGoogleToken({ refresh_token: refreshToken, grant_type: "refresh_token" });
  if (!ok || !data.access_token) {
    if (data.error === "invalid_grant") {
      await options.clear();
      throw options.reconnectRequired();
    }
    throw options.unreachable();
  }

  await options.save(data.access_token);
  return data.access_token;
}
