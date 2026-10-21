import { Request, Response } from "express";
import ClientBillingSvc from "../services/client-billing.service";
import { verifyStripeWebhook } from "../payments/stripe-client";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";

/**
 * POST /api/webhooks/stripe, called by Stripe only. Mounted in app.ts with express.raw() ahead of the
 * global express.json(): the signature is computed over the exact bytes Stripe sent, and a parsed
 * then re-serialised body would never match. A bad signature is a 400; once verified, a 200 tells
 * Stripe not to retry, and an error (500) makes it retry, which is safe because handling is
 * idempotent.
 */
export default class StripeWebhookCtrl {
  static async handle(req: Request, res: Response) {
    if (!Buffer.isBuffer(req.body)) {
      throw new HttpError("Webhook body wasn't read raw; check the mount order in app.ts", 500, "STRIPE_WEBHOOK_MISCONFIGURED");
    }
    const event = verifyStripeWebhook(req.body, req.header("stripe-signature"));
    const { duplicate } = await ClientBillingSvc.handleStripeEvent(event);
    logger.info("Stripe webhook handled", { eventId: event.id, type: event.type, duplicate });
    res.status(200).json({ received: true, duplicate });
  }
}
