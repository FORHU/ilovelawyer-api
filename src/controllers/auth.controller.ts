import { Request, Response } from "express";
import Joi from "joi";
import AuthSvc from "../services/auth.service";
import HttpError from "../utils/http-error";

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
    const { email, password } = req.body;

    const schema = Joi.object({
      email: Joi.string().email().required(),
      password: Joi.string().min(8).required(),
    });

    const { error } = schema.validate({ email, password });
    if (error) {
      throw new HttpError(error.message, 400);
    }

    const result = await AuthSvc.login(email, password);

    return res.status(200).json(result);
  }

  static async refresh(req: Request, res: Response) {
    const { refreshToken } = req.body;

    const schema = Joi.object({
      refreshToken: Joi.string().required(),
    });

    const { error } = schema.validate({ refreshToken });
    if (error) {
      throw new HttpError(error.message, 400);
    }

    const result = await AuthSvc.refresh(refreshToken);

    return res.status(200).json(result);
  }

  static async logout(req: Request, res: Response) {
    const { refreshToken } = req.body;

    const schema = Joi.object({
      refreshToken: Joi.string().required(),
    });

    const { error } = schema.validate({ refreshToken });
    if (error) {
      throw new HttpError(error.message, 400);
    }

    await AuthSvc.logout(refreshToken);

    return res.status(200).json({ message: "Logged out successfully" });
  }
}
