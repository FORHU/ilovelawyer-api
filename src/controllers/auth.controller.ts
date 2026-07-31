import { Request, Response } from "express";
import Joi from "joi";
import AuthSvc from "../services/auth.service";
import HttpError from "../utils/http-error";
import { REFRESH_TOKEN_COOKIE, setRefreshTokenCookie, clearRefreshTokenCookie } from "../utils/refreshTokenCookie";

export default class AuthCtrl {
  static async signup(req: Request, res: Response) {
    const { username, email, password } = req.body;

    const schema = Joi.object({
      username: Joi.string().required(),
      email: Joi.string().email().required(),
      password: Joi.string().min(8).required(),
    });

    const { error } = schema.validate({ username, email, password });
    if (error) {
      throw new HttpError(error.message, 400);
    }

    const user = await AuthSvc.signup(username, email, password);

    return res.status(201).json({
      id: user.id,
      username: user.username,
      email: user.email,
    });
  }

  static async login(req: Request, res: Response) {
    const { email, password, remember } = req.body;

    const schema = Joi.object({
      email: Joi.string().email().required(),
      password: Joi.string().min(8).required(),
      remember: Joi.boolean().optional(),
    });

    const { error } = schema.validate({ email, password, remember });
    if (error) {
      throw new HttpError(error.message, 400);
    }

    const { user, accessToken, refreshToken } = await AuthSvc.login(email, password, !!remember);
    setRefreshTokenCookie(res, refreshToken, !!remember);

    return res.status(200).json({ user, accessToken });
  }

  static async refresh(req: Request, res: Response) {
    const refreshToken = req.cookies?.[REFRESH_TOKEN_COOKIE];
    if (!refreshToken) {
      throw new HttpError("Invalid or expired refresh token", 401);
    }

    const { accessToken, refreshToken: newRefreshToken, remember } = await AuthSvc.refresh(refreshToken);
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

    const schema = Joi.object({
      idToken: Joi.string().required(),
      remember: Joi.boolean().optional(),
    });

    const { error } = schema.validate({ idToken, remember });
    if (error) {
      throw new HttpError(error.message, 400);
    }

    const { user, accessToken, refreshToken } = await AuthSvc.loginWithGoogle(idToken, remember ?? true);
    setRefreshTokenCookie(res, refreshToken, remember ?? true);

    return res.status(200).json({ user, accessToken });
  }

  static async refreshGoogleToken(req: Request, res: Response) {
    const result = await AuthSvc.refreshGoogleToken(req.user.userId);
    return res.status(200).json(result);
  }

  static async forgotPassword(req: Request, res: Response) {
    const { email } = req.body;

    const schema = Joi.object({
      email: Joi.string().email().required(),
    });

    const { error } = schema.validate({ email });
    if (error) {
      throw new HttpError(error.message, 400);
    }

    const result = await AuthSvc.forgotPassword(email);

    return res.status(200).json(result);
  }

  static async validateResetToken(req: Request, res: Response) {
    const { token } = req.query;

    const schema = Joi.object({
      token: Joi.string().required(),
    });

    const { error } = schema.validate({ token });
    if (error) {
      throw new HttpError(error.message, 400);
    }

    const valid = await AuthSvc.validateResetToken(token as string);

    return res.status(200).json({ valid });
  }

  static async resetPassword(req: Request, res: Response) {
    const { token, password } = req.body;

    const schema = Joi.object({
      token: Joi.string().required(),
      password: Joi.string().min(8).required(),
    });

    const { error } = schema.validate({ token, password });
    if (error) {
      throw new HttpError(error.message, 400);
    }

    const { accessToken, refreshToken } = await AuthSvc.resetPassword(token, password);
    setRefreshTokenCookie(res, refreshToken, true);

    return res.status(200).json({ accessToken });
  }

  static async sendOtp(req: Request, res: Response) {
    const { email } = req.body;

    const schema = Joi.object({
      email: Joi.string().email().required(),
    });

    const { error } = schema.validate({ email });
    if (error) {
      throw new HttpError(error.message, 400);
    }

    const result = await AuthSvc.sendOtp(email);

    return res.status(200).json(result);
  }

  static async verifyOtp(req: Request, res: Response) {
    const { email, code } = req.body;

    const schema = Joi.object({
      email: Joi.string().email().required(),
      code: Joi.string().length(6).required(),
    });

    const { error } = schema.validate({ email, code });
    if (error) {
      throw new HttpError(error.message, 400);
    }

    const { user, accessToken, refreshToken } = await AuthSvc.verifyOtp(email, code);
    setRefreshTokenCookie(res, refreshToken, true);

    return res.status(200).json({ user, accessToken });
  }
}
