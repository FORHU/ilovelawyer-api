import bcrypt from "bcrypt";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import AuthRepo from "../repositories/auth.repository";
import loginToken from "../utils/loginToken";
import verifyGoogleToken from "../utils/googleToken";
import HttpError from "../utils/http-error";
import { sendEmail } from "../utils/mailer";
import { renderTemplate } from "../utils/template";
import { REFRESH_TOKEN_SECRET, REFRESH_TOKEN_EXPIRY_DAYS, CLIENT_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } from "../config";
import { BCRYPT_SALT_ROUNDS, OTP_EXPIRY_MS } from "../constants/auth.constants";

export default class AuthSvc {
  static async signup(username: string, email: string, password: string) {
    const existingUser = await AuthRepo.findByEmail(email);
    if (existingUser) {
      throw new HttpError("Email already in use", 409);
    }

    const hashedPassword = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
    return AuthRepo.createUser(username, email, hashedPassword);
  }

  static async login(email: string, password: string, remember = false) {
    const user = await AuthRepo.findByEmail(email);
    if (!user || !user.password) {
      throw new HttpError("Invalid email or password", 401);
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      throw new HttpError("Invalid email or password", 401);
    }

    if (!user.isActive) {
      throw new HttpError("This account has been deactivated", 403);
    }

    const { accessToken, refreshToken } = loginToken(user.id, remember);

    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    await AuthRepo.createSession(user.id, refreshToken, expiresAt);
    await AuthRepo.updateLastLogin(user.id);

    return {
      user: await AuthRepo.findById(user.id),
      accessToken,
      refreshToken,
    };
  }

  static async refresh(refreshToken: string) {
    let payload: { userId: string; remember?: boolean };
    try {
      payload = jwt.verify(refreshToken, REFRESH_TOKEN_SECRET) as { userId: string; remember?: boolean };
    } catch {
      throw new HttpError("Invalid or expired refresh token", 401);
    }

    const session = await AuthRepo.findByRefreshToken(refreshToken);
    if (!session) {
      throw new HttpError("Invalid or expired refresh token", 401);
    }

    const user = await AuthRepo.findById(payload.userId);
    await AuthRepo.deleteByRefreshToken(refreshToken);

    if (!user || !user.isActive) {
      throw new HttpError("This account has been deactivated", 403);
    }

    const remember = !!payload.remember;
    const { accessToken, refreshToken: newRefreshToken } = loginToken(payload.userId, remember);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    await AuthRepo.createSession(payload.userId, newRefreshToken, expiresAt);

    return { accessToken, refreshToken: newRefreshToken, remember };
  }

  static async logout(refreshToken: string) {
    await AuthRepo.deleteByRefreshToken(refreshToken);
  }

  static async loginWithGoogle(idToken: string, remember = true) {
    const { googleId, email, name, isEmailVerified } = await verifyGoogleToken(idToken);

    if (!googleId) {
      throw new HttpError("Invalid Google token", 401);
    }

    if (!isEmailVerified) {
      throw new HttpError("Google account email is not verified", 401);
    }

    let user = await AuthRepo.findByGoogleId(googleId);

    if (!user) {
      const existingByEmail = await AuthRepo.findByEmail(email);
      if (existingByEmail) {
        throw new HttpError("Email already registered with a different sign-in method", 409);
      }

      user = await AuthRepo.createGoogleUser(email, googleId, name ?? undefined);
    } else {
      if (!user.isActive) {
        throw new HttpError("This account has been deactivated", 403);
      }
      await AuthRepo.updateLastLogin(user.id);
    }

    const { accessToken, refreshToken } = loginToken(user.id, remember);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    await AuthRepo.createSession(user.id, refreshToken, expiresAt);

    return {
      user: await AuthRepo.findById(user.id),
      accessToken,
      refreshToken,
    };
  }

  static async refreshGoogleToken(userId: string) {
    const googleRefreshToken = await AuthRepo.findGoogleRefreshToken(userId);
    if (!googleRefreshToken) {
      throw new HttpError("No refresh token — user must reconnect Google", 400);
    }

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: googleRefreshToken,
        grant_type: "refresh_token",
      }),
    });

    const data = await tokenRes.json();
    if (!tokenRes.ok || !data.access_token) {
      throw new HttpError(data.error ?? "Refresh failed", 400);
    }

    await AuthRepo.updateGoogleAccessToken(userId, data.access_token);

    return { access_token: data.access_token };
  }

  static async forgotPassword(email: string) {
    const user = await AuthRepo.findByEmail(email);
    const result = { message: "If the email exists, a reset link will be sent" };

    if (user) {
      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + OTP_EXPIRY_MS);
      await AuthRepo.setResetToken(user.id, token, expiresAt);

      const resetLink = `${CLIENT_URL[0]}/reset-password?token=${token}`;
      const html = await renderTemplate("reset-password", {
        name: user.name || "User",
        resetLink,
      });

      await sendEmail({
        to: user.email,
        subject: "Reset your password",
        html,
      });
    }

    return result;
  }

  static async validateResetToken(token: string): Promise<boolean> {
    return AuthRepo.isResetTokenValid(token);
  }

  static async resetPassword(token: string, password: string, remember = true) {
    const hashedPassword = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
    const userId = await AuthRepo.consumeResetToken(token, hashedPassword);
    if (!userId) {
      throw new HttpError("Invalid or expired reset token", 400);
    }

    await AuthRepo.deleteSessionsByUserId(userId);

    const { accessToken, refreshToken } = loginToken(userId, remember);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    await AuthRepo.createSession(userId, refreshToken, expiresAt);

    return { accessToken, refreshToken };
  }

  static async sendOtp(email: string) {
    const user = await AuthRepo.findByEmail(email);
    if (!user) {
      throw new HttpError("User not found", 404);
    }

    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MS);
    await AuthRepo.setEmailVerificationOtp(user.id, code, expiresAt);

    const html = await renderTemplate("verify-email", {
      name: user.name || "User",
      code,
    });

    await sendEmail({
      to: user.email,
      subject: "Verify your email",
      html,
    });

    return { message: "Verification code sent" };
  }

  static async verifyOtp(email: string, code: string, remember = true) {
    const user = await AuthRepo.consumeEmailVerificationOtp(email, code);
    if (!user) {
      throw new HttpError("Invalid or expired code", 400);
    }

    const { accessToken, refreshToken } = loginToken(user.id, remember);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    await AuthRepo.createSession(user.id, refreshToken, expiresAt);
    await AuthRepo.updateLastLogin(user.id);

    return {
      user: await AuthRepo.findById(user.id),
      accessToken,
      refreshToken,
    };
  }
}
