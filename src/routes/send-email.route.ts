import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import { Request, Response } from "express";
import Joi from "joi";
import { sendEmail } from "../utils/mailer";
import HttpError from "../utils/http-error";

const router = express.Router();

router.use(validSession);

router.post("/", asyncHandler(async (req: Request, res: Response) => {
  const schema = Joi.object({
    to: Joi.string().email().required(),
    subject: Joi.string().required(),
    text: Joi.string().optional(),
    html: Joi.string().optional(),
  }).or("text", "html");

  const { error, value } = schema.validate(req.body);
  if (error) throw new HttpError(error.message, 400);

  await sendEmail(value);
  return res.status(200).json({ message: "Email sent successfully" });
}));

export default router;
