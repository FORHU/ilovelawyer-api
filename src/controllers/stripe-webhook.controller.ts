import { Request, Response } from "express";
import StripeWebhookSvc from "../services/stripe-webhook.service";
import { verifyStripeWebhook } from "../payments/stripe-client";
import { STRIPE_CONNECT_WEBHOOK_SECRET } from "../config";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";

/**
 * POST /api/webhooks/stripe, called by Stripe only. Mounted in app.ts with express.raw() ahead of the
 * global express.json(): the signature is computed over the exact bytes Stripe sent, and a parsed
 * then re-serialised body would never match. A bad signature is a 400; once verified, a 200 tells
 * Stripe not to retry, and an error (500) makes it retry, which is safe because handling is
 * idempotent.
 *
 * StripeWebhookSvc routes the event to every billing service and records it once they've all
 * applied it.
 */
export default class StripeWebhookCtrl {
  static async handle(req: Request, res: Response) {
    if (!Buffer.isBuffer(req.body)) {
      throw new HttpError("Webhook body wasn't read raw; check the mount order in app.ts", 500, "STRIPE_WEBHOOK_MISCONFIGURED");
    }
    const event = verifyStripeWebhook(req.body, req.header("stripe-signature"));
    const { duplicate } = await StripeWebhookSvc.handle(event);
    logger.info("Stripe webhook handled", { eventId: event.id, type: event.type, duplicate });
    res.status(200).json({ received: true, duplicate });
  }

  /** POST /api/webhooks/stripe-connect: events on lawyers' connected accounts (account.updated,
   * payout.paid, payout.failed), signed with STRIPE_CONNECT_WEBHOOK_SECRET. Deduplicated with the
   * same StripeWebhookEvent table; WalletSvc is idempotent too. */
  static async handleConnect(req: Request, res: Response) {
    if (!Buffer.isBuffer(req.body)) {
      throw new HttpError("Webhook body wasn't read raw; check the mount order in app.ts", 500, "STRIPE_WEBHOOK_MISCONFIGURED");
    }
    const event = verifyStripeWebhook(req.body, req.header("stripe-signature"), STRIPE_CONNECT_WEBHOOK_SECRET);
    const { duplicate } = await StripeWebhookSvc.handleConnect(event);
    logger.info("Stripe Connect webhook handled", { eventId: event.id, type: event.type, account: event.account, duplicate });
    res.status(200).json({ received: true, duplicate });
  }
}
