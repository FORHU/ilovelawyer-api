import express from "express";
import asyncHandler from "../utils/async-handler";
import { Request, Response } from "express";
import Joi from "joi";
import prisma from "../lib/prisma";
import { sendEmail } from "../utils/mailer";
import HttpError from "../utils/http-error";

const router = express.Router();

router.post("/:eventId", asyncHandler(async (req: Request, res: Response) => {
  const schema = Joi.object({
    status: Joi.string().valid("accepted", "declined").required(),
    clientEmail: Joi.string().email().required(),
    feedback: Joi.string().optional(),
  });

  const { error, value } = schema.validate(req.body);
  if (error) throw new HttpError(error.message, 400);

  const event = await prisma.event.findUnique({ where: { id: req.params.eventId } });
  if (!event) throw new HttpError("Event not found", 404);

  await prisma.event.update({
    where: { id: req.params.eventId },
    data: {
      status: value.status,
      clientFeedback: value.feedback ?? null,
    },
  });

  // Notify the lawyer
  const lawyer = await prisma.user.findUnique({
    where: { id: event.userId },
    select: { email: true, name: true },
  });

  if (lawyer?.email) {
    const statusLabel = value.status === "accepted" ? "accepted" : "declined";
    await sendEmail({
      to: lawyer.email,
      subject: `Client ${statusLabel} — ${event.title}`,
      text: [
        `Client ${value.clientEmail} has ${statusLabel} the event "${event.title}".`,
        value.feedback ? `Feedback: ${value.feedback}` : "",
      ].filter(Boolean).join("\n"),
    });
  }

  return res.status(200).json({ message: `RSVP ${value.status}` });
}));

export default router;
