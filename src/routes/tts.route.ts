import express from "express";
import asyncHandler from "../utils/async-handler";
import validSession from "../middleware/valid-session.middleware";
import { Request, Response } from "express";
import Joi from "joi";
import { PollyClient, SynthesizeSpeechCommand, OutputFormat, VoiceId } from "@aws-sdk/client-polly";
import { AWS_ACCESS_KEY, AWS_SECRET_ACCESS_KEY, AWS_REGION } from "../config";
import HttpError from "../utils/http-error";

const router = express.Router();
router.use(validSession);

const polly = new PollyClient({
  region: AWS_REGION,
  credentials: { accessKeyId: AWS_ACCESS_KEY, secretAccessKey: AWS_SECRET_ACCESS_KEY },
});

router.post("/polly", asyncHandler(async (req: Request, res: Response) => {
  const schema = Joi.object({
    text: Joi.string().max(3000).required(),
    voiceId: Joi.string().default("Joanna"),
  });

  const { error, value } = schema.validate(req.body);
  if (error) throw new HttpError(error.message, 400);

  const command = new SynthesizeSpeechCommand({
    Text: value.text,
    OutputFormat: OutputFormat.MP3,
    VoiceId: value.voiceId as VoiceId,
    Engine: "neural",
  });

  const result = await polly.send(command);
  if (!result.AudioStream) throw new HttpError("Polly returned no audio", 502);

  const chunks: Uint8Array[] = [];
  for await (const chunk of result.AudioStream as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);

  res.set("Content-Type", "audio/mpeg");
  res.set("Content-Length", String(buffer.length));
  return res.status(200).send(buffer);
}));

export default router;
