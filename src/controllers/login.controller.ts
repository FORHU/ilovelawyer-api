import { Request, Response } from "express";
import Joi from "joi";
import LoginSVC from "../services/login.service";
import HttpError from "../utils/http-error";

    export default class LoginCtrl {
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

        const result = await LoginSVC.login(email, password);

        return res.status(200).json(result);
        }
    }

        
