import { Request, Response } from "express";
import LawyerProfileSvc from "../services/lawyer-profile.service";
import HttpError from "../utils/http-error";
import { updateLawyerProfileSchema } from "../validation/lawyer-profile.validation";

/** /api/users/me/client-request-profile: a lawyer's own settings for receiving client requests. */
export default class LawyerProfileCtrl {
  static async get(req: Request, res: Response) {
    res.status(200).json(await LawyerProfileSvc.get(req.user.userId));
  }

  static async update(req: Request, res: Response) {
    const { error, value } = updateLawyerProfileSchema.validate(req.body, { stripUnknown: true });
    if (error) throw new HttpError(error.message, 400);
    // "" clears the number, the same as null.
    if (value.registrationNumber === "") value.registrationNumber = null;
    res.status(200).json(await LawyerProfileSvc.update(req.user.userId, value));
  }
}
