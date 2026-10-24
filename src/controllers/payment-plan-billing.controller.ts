import { Request, Response } from "express";
import PaymentPlanBillingSvc from "../services/payment-plan-billing.service";
import HttpError from "../utils/http-error";
import { changePaymentPlanSchema, startPaymentPlanCheckoutSchema } from "../validation/payment-plan-billing.validation";

/** A lawyer's own subscription to one of their tenant's tiers. Mounted outside the case router, like
 * the account top-up, so a locked (read-only) account can still choose a plan. */
export default class PaymentPlanBillingCtrl {
  static async options(req: Request, res: Response) {
    res.status(200).json(await PaymentPlanBillingSvc.options(req.user.userId));
  }

  static async startCheckout(req: Request, res: Response) {
    const { error, value } = startPaymentPlanCheckoutSchema.validate(req.body ?? {});
    if (error) throw new HttpError(error.message, 400);
    res.status(201).json(await PaymentPlanBillingSvc.startCheckout(req.user.userId, value.planCode, req.headers.origin));
  }

  static async previewChange(req: Request, res: Response) {
    const { error, value } = changePaymentPlanSchema.validate(req.query ?? {});
    if (error) throw new HttpError(error.message, 400);
    res.status(200).json(await PaymentPlanBillingSvc.previewChange(req.user.userId, value.planCode));
  }

  static async changePlan(req: Request, res: Response) {
    const { error, value } = changePaymentPlanSchema.validate(req.body ?? {});
    if (error) throw new HttpError(error.message, 400);
    res.status(200).json(await PaymentPlanBillingSvc.changePlan(req.user.userId, value.planCode));
  }

  static async status(req: Request, res: Response) {
    res.status(200).json(await PaymentPlanBillingSvc.status(req.user.userId, req.params.subscriptionId));
  }
}
