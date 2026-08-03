import { GOOGLE_CLIENT_ID } from "../config";
import HttpError from "./http-error";

interface GoogleTokenInfo {
  aud?: string;
  azp?: string;
}

interface GoogleUserInfo {
  sub: string;
  email?: string;
  name?: string;
  email_verified?: boolean;
}

// The frontend's useGoogleLogin() uses the implicit flow, which hands back an
// OAuth access token — not a JWT ID token — so this validates it the way Google
// access tokens are meant to be validated: confirm via tokeninfo that it was
// actually issued to *our* OAuth client (otherwise a token minted for some other
// app could be replayed here), then fetch the profile via the userinfo endpoint.
export default async function verifyGoogleToken(accessToken: string) {
  try {
    const tokenInfoRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`,
    );
    if (!tokenInfoRes.ok) throw new Error("tokeninfo request failed");
    const tokenInfo: GoogleTokenInfo = await tokenInfoRes.json();
    if (tokenInfo.aud !== GOOGLE_CLIENT_ID && tokenInfo.azp !== GOOGLE_CLIENT_ID) {
      throw new Error("Token was not issued for this app");
    }

    const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!userInfoRes.ok) throw new Error("userinfo request failed");
    const payload: GoogleUserInfo = await userInfoRes.json();
    if (!payload.email) throw new Error("Missing email in Google profile");

    return {
      googleId: payload.sub,
      email: payload.email,
      name: payload.name,
      isEmailVerified: payload.email_verified ?? false,
    };
  } catch {
    throw new HttpError("Invalid Google token", 401);
  }
}
