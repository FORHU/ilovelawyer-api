import jwt from "jsonwebtoken";
import RefreshRepo from "../repositories/refresh.repository";
import loginToken from "../utils/loginToken";
import HttpError from "../utils/http-error";
import { REFRESH_TOKEN_SECRET, REFRESH_TOKEN_EXPIRY_DAYS } from "../config";

export default class RefreshSvc {
  static async refresh(refreshToken: string) {
    let payload: { userId: string };
    try {
      payload = jwt.verify(refreshToken, REFRESH_TOKEN_SECRET) as { userId: string };
    } catch {
      throw new HttpError("Invalid or expired refresh token", 401);
    }

    const session = await RefreshRepo.findByRefreshToken(refreshToken);
    if (!session) {
      throw new HttpError("Invalid or expired refresh token", 401);
    }

    await RefreshRepo.deleteByRefreshToken(refreshToken);

    const { accessToken, refreshToken: newRefreshToken } = loginToken(payload.userId);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    await RefreshRepo.createSession(payload.userId, newRefreshToken, expiresAt);

    return { accessToken, refreshToken: newRefreshToken };
  }
}
