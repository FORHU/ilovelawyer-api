import { Request, Response } from "express";
import Joi from "joi";
import WalletSvc from "../services/wallet.service";
import type { WalletOwner } from "../repositories/wallet.repository";
import { firmIdOf } from "../utils/workspace";
import HttpError from "../utils/http-error";

const pageSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
});
const onboardingSchema = Joi.object({ returnUrl: Joi.string().trim().max(2048).required() });
const withdrawSchema = Joi.object({
  amount: Joi.object({
    amountMinor: Joi.number().integer().min(1).required(),
    currency: Joi.string().valid("GBP").required(),
  }).required(),
});
const idempotencyKeySchema = Joi.string().trim().min(8).max(200).required().messages({ "any.required": "Send an Idempotency-Key header with each withdrawal." });

function validate<T>(schema: Joi.Schema, input: unknown): T {
  const { error, value } = schema.validate(input ?? {}, { stripUnknown: true, convert: true });
  if (error) throw new HttpError(error.message, 400);
  return value as T;
}

/** /users/me/wallet: a solo lawyer's own. /organizations/:id/wallet: the firm's, OWNER/ADMIN only
 * (organization.route.ts). Which one a lawyer's earnings land in is payeeOf's call (wallet.service.ts). */
function ownerOf(req: Request): WalletOwner {
  return req.params.id ? { ownerType: "ORGANIZATION", ownerId: firmIdOf(req) } : { ownerType: "USER", ownerId: req.user.userId };
}

/** A payee's earnings and withdrawals (WalletSvc): the lawyer app's Earnings page. */
export default class WalletCtrl {
  /** GET .../wallet — balances, payout account, the tenant's minimum withdrawal and hold. */
  static async get(req: Request, res: Response) {
    res.status(200).json(await WalletSvc.get(ownerOf(req)));
  }

  /** GET .../wallet/ledger[?page=&limit=] — every movement, newest first. */
  static async ledger(req: Request, res: Response) {
    const { page, limit } = validate<{ page: number; limit: number }>(pageSchema, req.query);
    res.status(200).json(await WalletSvc.ledger(ownerOf(req), page, limit));
  }

  /** GET .../wallet/earnings[?page=&limit=] — one per client payment. */
  static async earnings(req: Request, res: Response) {
    const { page, limit } = validate<{ page: number; limit: number }>(pageSchema, req.query);
    res.status(200).json(await WalletSvc.earnings(ownerOf(req), page, limit));
  }

  /** GET .../wallet/withdrawals[?page=&limit=] */
  static async withdrawals(req: Request, res: Response) {
    const { page, limit } = validate<{ page: number; limit: number }>(pageSchema, req.query);
    res.status(200).json(await WalletSvc.withdrawals(ownerOf(req), page, limit));
  }

  /** POST .../wallet/withdrawals — body { amount }, header Idempotency-Key. */
  static async withdraw(req: Request, res: Response) {
    const { amount } = validate<{ amount: { amountMinor: number } }>(withdrawSchema, req.body);
    const key = validate<string>(idempotencyKeySchema, req.header("idempotency-key"));
    res.status(201).json(await WalletSvc.withdraw(ownerOf(req), req.user.userId, amount.amountMinor, key));
  }

  /** POST .../wallet/payout-account/onboarding-link — body { returnUrl }: Stripe's page to set up
   * where the payee is paid (url null when there's nothing to do there). */
  static async onboardingLink(req: Request, res: Response) {
    const { returnUrl } = validate<{ returnUrl: string }>(onboardingSchema, req.body);
    res.status(200).json(await WalletSvc.startOnboarding(ownerOf(req), req.user.userId, returnUrl));
  }

  /** POST .../wallet/payout-account/refresh — the account's state read from Stripe again. */
  static async refreshAccount(req: Request, res: Response) {
    res.status(200).json(await WalletSvc.refreshAccount(ownerOf(req)));
  }
}
