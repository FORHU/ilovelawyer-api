import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import { Request, Response } from "express";
import Joi from "joi";
import { sendEmail } from "../utils/mailer";
import HttpError from "../utils/http-error";
import SecurityAuditSvc from "../services/security-audit.service";

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
  // Any signed-in user can send mail from the platform's address here, so each send is recorded —
  // the recipient and subject length only, never the body.
  await SecurityAuditSvc.record({
    action: "email.sent",
    payload: { to: value.to, subjectLength: value.subject.length, format: value.html ? "html" : "text" },
  });
  return res.status(200).json({ message: "Email sent successfully" });
}));

export default router;
