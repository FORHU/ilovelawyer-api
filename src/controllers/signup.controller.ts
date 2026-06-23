import { Request, Response } from "express";
import Joi from "joi";
import SignupSvc from "../services/signup.service";
import HttpError from "../utils/http-error";

export default class SignupCtrl {
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

    const user = await SignupSvc.signup(username, email, password);

    return res.status(201).json({
      id: user.id,
      username: user.username,
      email: user.email,
    });
  }
}
