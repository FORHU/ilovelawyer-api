import { Request, Response } from "express";
import AccountTopUpBillingSvc from "../services/account-topup-billing.service";
import HttpError from "../utils/http-error";
import { quoteAccountTopUpSchema, startAccountTopUpCheckoutSchema } from "../validation/account-topup.validation";

/** A lawyer's self-serve top-up of their own account's AI allowance. Mounted outside the case
 * router so accountSpendLimit's gating never applies here — the whole point is these routes keep
 * working on a locked account. */
export default class AccountTopUpCtrl {
  static async quote(req: Request, res: Response) {
    const { error, value } = quoteAccountTopUpSchema.validate(req.body ?? {});
    if (error) throw new HttpError(error.message, 400);
    res.status(200).json(await AccountTopUpBillingSvc.quote(req.user.userId, value.topUpAmountUsd));
  }

  static async startCheckout(req: Request, res: Response) {
    const { error, value } = startAccountTopUpCheckoutSchema.validate(req.body ?? {});
    if (error) throw new HttpError(error.message, 400);
    res.status(201).json(await AccountTopUpBillingSvc.startCheckout(req.user.userId, value.topUpAmountUsd, req.headers.origin));
  }

  static async status(req: Request, res: Response) {
    res.status(200).json(await AccountTopUpBillingSvc.status(req.user.userId, req.params.topUpId));
  }
}
