import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } from "../config";

export async function refreshGoogleAccessToken(refreshToken: string): Promise<string | null> {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    console.error("[google-token] GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is not set.");
    return null;
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    console.error("[google-token] Token refresh failed:", await res.text());
    return null;
  }

  const data = await res.json();
  return data.access_token ?? null;
}
