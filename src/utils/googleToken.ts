import { OAuth2Client } from "google-auth-library";
import { GOOGLE_CLIENT_ID } from "../config";
import HttpError from "./http-error";

const client = new OAuth2Client(GOOGLE_CLIENT_ID);

export default async function verifyGoogleToken(idToken: string) {
  let payload;
  try {
    const ticket = await client.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch {
    throw new HttpError("Invalid Google token", 401);
  }

  if (!payload || !payload.email) {
    throw new HttpError("Invalid Google token", 401);
  }

  return {
    googleId: payload.sub,
    email: payload.email,
    name: payload.name,
    isEmailVerified: payload.email_verified ?? false,
  };
}
