import { Request, Response } from "express";
import AuthSvc from "../services/auth.service";
import HttpError from "../utils/http-error";
import { REFRESH_TOKEN_COOKIE, setRefreshTokenCookie, clearRefreshTokenCookie } from "../utils/refreshTokenCookie";
import { requestFrontendOrigin, resolveTenantCodeFromRequest } from "../utils/tenant-host";
import {
  signupSchema,
  loginSchema,
  updateRequiredPasswordSchema,
  googleLoginSchema,
  googleLinkSchema,
  forgotPasswordSchema,
  validateResetTokenSchema,
  resetPasswordSchema,
  sendOtpSchema,
  verifyOtpSchema,
  cancelSignupSchema,
  consumeLoginLinkSchema,
} from "../validation/auth.validation";

export default class AuthCtrl {
  static async signup(req: Request, res: Response) {
    const { username, email, password, name, acceptedTerms } = req.body;

    const { error } = signupSchema.validate({ username, email, password, name, acceptedTerms });
    if (error) {
      throw new HttpError(error.message, 400);
    }

    const user = await AuthSvc.signup(username, email, password, name, resolveTenantCodeFromRequest(req), acceptedTerms === true);

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

    const { user, accessToken, refreshToken, deletionCancelled } = await AuthSvc.login(email, password, !!remember, resolveTenantCodeFromRequest(req));
    setRefreshTokenCookie(res, refreshToken, !!remember);

    return res.status(200).json({ user, accessToken, deletionCancelled });
  }

  /** Completes the one-time forced password update a 428 from login() sends the client to. */
  static async updateRequiredPassword(req: Request, res: Response) {
    const { email, currentPassword, newPassword, remember } = req.body;

    const { error } = updateRequiredPasswordSchema.validate({ email, currentPassword, newPassword, remember });
    if (error) {
      throw new HttpError(error.message, 400);
    }

    const { user, accessToken, refreshToken, deletionCancelled } = await AuthSvc.updateRequiredPassword(
      email,
      currentPassword,
      newPassword,
      !!remember,
      resolveTenantCodeFromRequest(req),
    );
    setRefreshTokenCookie(res, refreshToken, !!remember);

    return res.status(200).json({ user, accessToken, deletionCancelled });
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
    const { idToken, remember, acceptedTerms } = req.body;

    const { error } = googleLoginSchema.validate({ idToken, remember, acceptedTerms });
    if (error) {
      throw new HttpError(error.message, 400);
    }

    // The app always sends `remember` now (the sign-in tab's checkbox, or true from the
    // sign-up tab); the `true` fallback only keeps older clients' behavior unchanged.
    const { user, accessToken, refreshToken, deletionCancelled } = await AuthSvc.loginWithGoogle(
      idToken,
      remember ?? true,
      resolveTenantCodeFromRequest(req),
      acceptedTerms === true,
    );
    setRefreshTokenCookie(res, refreshToken, remember ?? true);

    return res.status(200).json({ user, accessToken, deletionCancelled });
  }

  /** Completes the password-confirmed link a GOOGLE_LINK_REQUIRED 409 from google() sends the
   * client to. */
  static async googleLink(req: Request, res: Response) {
    const { idToken, password, remember } = req.body;

    const { error } = googleLinkSchema.validate({ idToken, password, remember });
    if (error) {
      throw new HttpError(error.message, 400);
    }

    const { user, accessToken, refreshToken, deletionCancelled } = await AuthSvc.linkGoogle(
      idToken,
      password,
      !!remember,
      resolveTenantCodeFromRequest(req),
    );
    setRefreshTokenCookie(res, refreshToken, !!remember);

    return res.status(200).json({ user, accessToken, deletionCancelled });
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

    const result = await AuthSvc.forgotPassword(email, requestFrontendOrigin(req));

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

    const { accessToken, refreshToken, deletionCancelled } = await AuthSvc.resetPassword(token, password);
    setRefreshTokenCookie(res, refreshToken, true);

    return res.status(200).json({ accessToken, deletionCancelled });
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

  static async cancelSignup(req: Request, res: Response) {
    const { email } = req.body;

    const { error } = cancelSignupSchema.validate({ email });
    if (error) {
      throw new HttpError(error.message, 400);
    }

    const result = await AuthSvc.cancelSignup(email);

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

  static async consumeLoginLink(req: Request, res: Response) {
    const { token } = req.body;

    const { error } = consumeLoginLinkSchema.validate({ token });
    if (error) {
      throw new HttpError(error.message, 400);
    }

    const { user, accessToken, refreshToken, deletionCancelled } = await AuthSvc.consumeLoginLink(token);
    setRefreshTokenCookie(res, refreshToken, true);

    return res.status(200).json({ user, accessToken, deletionCancelled });
  }
}
