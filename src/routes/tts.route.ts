import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import { Request, Response } from "express";
import Joi from "joi";
import HttpError from "../utils/http-error";
import { synthesizeSpeechToBuffer } from "../utils/polly";

const router = express.Router();
router.use(validSession);

router.post("/polly", asyncHandler(async (req: Request, res: Response) => {
  const schema = Joi.object({
    text: Joi.string().max(3000).required(),
    voiceId: Joi.string().default("Joanna"),
  });

  const { error, value } = schema.validate(req.body);
  if (error) throw new HttpError(error.message, 400);

  const buffer = await synthesizeSpeechToBuffer(value.text, value.voiceId);

  res.set("Content-Type", "audio/mpeg");
  res.set("Content-Length", String(buffer.length));
  return res.status(200).send(buffer);
}));

export default router;
