import { Response } from "express";
import { isDev, REFRESH_TOKEN_EXPIRY_DAYS } from "../config";

export const REFRESH_TOKEN_COOKIE = "refreshToken";
// Non-httpOnly sibling of refreshToken: carries no secret, just a "1" flag, so the
// frontend can check document.cookie to decide whether a silent refresh could
// possibly succeed before spending a request on it. Mirrors refreshToken's
// lifetime (path scoped to "/" instead, since it must be readable from /login).
export const SESSION_HINT_COOKIE = "hasSession";

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: !isDev,
  sameSite: "lax" as const,
  path: "/api/auth",
};

const SESSION_HINT_OPTIONS = {
  httpOnly: false,
  secure: !isDev,
  sameSite: "lax" as const,
  path: "/",
};

export function setRefreshTokenCookie(res: Response, token: string, remember: boolean) {
  const maxAge = remember ? REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000 : undefined;
  res.cookie(REFRESH_TOKEN_COOKIE, token, {
    ...COOKIE_OPTIONS,
    ...(maxAge ? { maxAge } : {}),
  });
  res.cookie(SESSION_HINT_COOKIE, "1", {
    ...SESSION_HINT_OPTIONS,
    ...(maxAge ? { maxAge } : {}),
  });
}

export function clearRefreshTokenCookie(res: Response) {
  res.clearCookie(REFRESH_TOKEN_COOKIE, COOKIE_OPTIONS);
  res.clearCookie(SESSION_HINT_COOKIE, SESSION_HINT_OPTIONS);
}
