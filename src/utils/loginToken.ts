import crypto from "crypto";
import jwt from "jsonwebtoken";
import {
    ACCESS_TOKEN_SECRET,
    ACCESS_TOKEN_EXPIRY,
    REFRESH_TOKEN_SECRET,
    REFRESH_TOKEN_EXPIRY_DAYS,
} from "../config";

export default function loginToken(userId: string, remember = false) {
  const accessToken = jwt.sign({ userId }, ACCESS_TOKEN_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
  // jti keeps the token unique even when two are issued for the same user within
  // the same second (jwt's iat has 1s resolution) — e.g. React Strict Mode's
  // double-invoked refresh effect, which otherwise collides on Session.refreshToken's
  // unique constraint.
  const refreshToken = jwt.sign({ userId, remember, jti: crypto.randomUUID() }, REFRESH_TOKEN_SECRET, {
    expiresIn: `${REFRESH_TOKEN_EXPIRY_DAYS}d`,
  });

    return { accessToken, refreshToken };
}
