import { Request, Response } from "express";
import AuthSvc from "../services/auth.service";
import HttpError from "../utils/http-error";
import { REFRESH_TOKEN_COOKIE, setRefreshTokenCookie, clearRefreshTokenCookie } from "../utils/refreshTokenCookie";
import { resolveTenantCodeFromRequest } from "../utils/tenant-host";
import {
  signupSchema,
  loginSchema,
  googleLoginSchema,
  forgotPasswordSchema,
  validateResetTokenSchema,
  resetPasswordSchema,
  sendOtpSchema,
  verifyOtpSchema,
} from "../validation/auth.validation";

export default class AuthCtrl {
  static async signup(req: Request, res: Response) {
    const { username, email, password, name } = req.body;

    const { error } = signupSchema.validate({ username, email, password, name });
    if (error) {
      throw new HttpError(error.message, 400);
    }

    const user = await AuthSvc.signup(username, email, password, name, resolveTenantCodeFromRequest(req));

    return res.status(201).json({
      id: user.id,
      username: user.username,
      email: user.email,
      name: user.name,
    });
  }

  static async login(req: Request, res: Response) {
    const { email, password, remember } = req.body;

    const { error } = loginSchema.validate({ email, password, remember });
    if (error) {
      throw new HttpError(error.message, 400);
    }

    const { user, accessToken, refreshToken } = await AuthSvc.login(email, password, !!remember, resolveTenantCodeFromRequest(req));
    setRefreshTokenCookie(res, refreshToken, !!remember);

    return res.status(200).json({ user, accessToken });
  }

  static async refresh(req: Request, res: Response) {
    const refreshToken = req.cookies?.[REFRESH_TOKEN_COOKIE];
    if (!refreshToken) {
      throw new HttpError("Invalid or expired refresh token", 401);
    }

    const { accessToken, refreshToken: newRefreshToken, remember } = await AuthSvc.refresh(
      refreshToken,
      resolveTenantCodeFromRequest(req),
    );
    setRefreshTokenCookie(res, newRefreshToken, remember);

    return res.status(200).json({ accessToken });
  }

  static async logout(req: Request, res: Response) {
    const refreshToken = req.cookies?.[REFRESH_TOKEN_COOKIE];
    if (refreshToken) {
      await AuthSvc.logout(refreshToken);
    }
    clearRefreshTokenCookie(res);

    return res.status(200).json({ message: "Logged out successfully" });
  }

  static async google(req: Request, res: Response) {
    const { idToken, remember } = req.body;

    const { error } = googleLoginSchema.validate({ idToken, remember });
    if (error) {
      throw new HttpError(error.message, 400);
    }

    const { user, accessToken, refreshToken } = await AuthSvc.loginWithGoogle(
      idToken,
      remember ?? true,
      resolveTenantCodeFromRequest(req),
    );
    setRefreshTokenCookie(res, refreshToken, remember ?? true);

    return res.status(200).json({ user, accessToken });
  }

  static async refreshGoogleToken(req: Request, res: Response) {
    const result = await AuthSvc.refreshGoogleToken(req.user.userId);
    return res.status(200).json(result);
  }

  static async forgotPassword(req: Request, res: Response) {
    const { email } = req.body;

    const { error } = forgotPasswordSchema.validate({ email });
    if (error) {
      throw new HttpError(error.message, 400);
    }

    const result = await AuthSvc.forgotPassword(email);

    return res.status(200).json(result);
  }

  static async validateResetToken(req: Request, res: Response) {
    const { token } = req.query;

    const { error } = validateResetTokenSchema.validate({ token });
    if (error) {
      throw new HttpError(error.message, 400);
    }

    const valid = await AuthSvc.validateResetToken(token as string);

    return res.status(200).json({ valid });
  }

  static async resetPassword(req: Request, res: Response) {
    const { token, password } = req.body;

    const { error } = resetPasswordSchema.validate({ token, password });
    if (error) {
      throw new HttpError(error.message, 400);
    }

    const { accessToken, refreshToken } = await AuthSvc.resetPassword(token, password);
    setRefreshTokenCookie(res, refreshToken, true);

    return res.status(200).json({ accessToken });
  }

  static async sendOtp(req: Request, res: Response) {
    const { email } = req.body;

    const { error } = sendOtpSchema.validate({ email });
    if (error) {
      throw new HttpError(error.message, 400);
    }

    const result = await AuthSvc.sendOtp(email);

    return res.status(200).json(result);
  }

  static async verifyOtp(req: Request, res: Response) {
    const { email, code } = req.body;

    const { error } = verifyOtpSchema.validate({ email, code });
    if (error) {
      throw new HttpError(error.message, 400);
    }

    const { user, accessToken, refreshToken } = await AuthSvc.verifyOtp(email, code);
    setRefreshTokenCookie(res, refreshToken, true);

    return res.status(200).json({ user, accessToken });
  }
}
