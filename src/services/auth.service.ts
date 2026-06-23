import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import AuthRepo from "../repositories/auth.repository";
import loginToken from "../utils/loginToken";
import HttpError from "../utils/http-error";
import { REFRESH_TOKEN_SECRET, REFRESH_TOKEN_EXPIRY_DAYS } from "../config";

export default class AuthSvc {
  static async signup(username: string, email: string, password: string) {
    const existingUser = await AuthRepo.findByEmail(email);
    if (existingUser) {
      throw new HttpError("Email already in use", 409);
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    return AuthRepo.createUser(username, email, hashedPassword);
  }

  static async login(email: string, password: string) {
    const user = await AuthRepo.findByEmail(email);
    if (!user || !user.password) {
      throw new HttpError("Invalid email or password", 401);
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      throw new HttpError("Invalid email or password", 401);
    }

    const { accessToken, refreshToken } = loginToken(user.id);

    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    await AuthRepo.createSession(user.id, refreshToken, expiresAt);
    await AuthRepo.updateLastLogin(user.id);

    return {
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
      },
      accessToken,
      refreshToken,
    };
  }

  static async refresh(refreshToken: string) {
    let payload: { userId: string };
    try {
      payload = jwt.verify(refreshToken, REFRESH_TOKEN_SECRET) as { userId: string };
    } catch {
      throw new HttpError("Invalid or expired refresh token", 401);
    }

    const session = await AuthRepo.findByRefreshToken(refreshToken);
    if (!session) {
      throw new HttpError("Invalid or expired refresh token", 401);
    }

    await AuthRepo.deleteByRefreshToken(refreshToken);

    const { accessToken, refreshToken: newRefreshToken } = loginToken(payload.userId);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    await AuthRepo.createSession(payload.userId, newRefreshToken, expiresAt);

    return { accessToken, refreshToken: newRefreshToken };
  }

  static async logout(refreshToken: string) {
    await AuthRepo.deleteByRefreshToken(refreshToken);
  }
}
