import { Response } from "express";
import { isDev, REFRESH_TOKEN_EXPIRY_DAYS } from "../config";

export const REFRESH_TOKEN_COOKIE = "refreshToken";

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: !isDev,
  sameSite: "lax" as const,
  path: "/api/auth",
};

export function setRefreshTokenCookie(res: Response, token: string, remember: boolean) {
  res.cookie(REFRESH_TOKEN_COOKIE, token, {
    ...COOKIE_OPTIONS,
    ...(remember ? { maxAge: REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000 } : {}),
  });
}

export function clearRefreshTokenCookie(res: Response) {
  res.clearCookie(REFRESH_TOKEN_COOKIE, COOKIE_OPTIONS);
}
