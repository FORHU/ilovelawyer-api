import { Request, Response } from "express";
import { ConsentPurpose } from "@prisma/client";
import ConsentSvc from "../services/consent.service";
import HttpError from "../utils/http-error";
import { consentPurposeSchema, setConsentSchema } from "../validation/consent.validation";

export default class ConsentCtrl {
  static async list(req: Request, res: Response) {
    return res.status(200).json(await ConsentSvc.list(req.user.userId));
  }

  static async set(req: Request, res: Response) {
    const purposeCheck = consentPurposeSchema.validate(req.params.purpose);
    if (purposeCheck.error) throw new HttpError("Unknown consent purpose", 400);
    const { error, value } = setConsentSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);

    const result = await ConsentSvc.set(req.user.userId, purposeCheck.value as ConsentPurpose, value.granted, value.source);
    return res.status(200).json(result);
  }
}
