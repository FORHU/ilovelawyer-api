import { Request, Response } from "express";
import LawyerProfileSvc from "../services/lawyer-profile.service";
import HttpError from "../utils/http-error";
import { updateLawyerProfileSchema } from "../validation/lawyer-profile.validation";

/** "" in a registration text field clears it, the same as null. */
function blanksToNull(registration: Record<string, unknown> | undefined) {
  if (!registration) return registration;
  return Object.fromEntries(Object.entries(registration).map(([k, v]) => [k, v === "" ? null : v]));
}

/** /api/users/me/client-request-profile: a lawyer's own Lawyer Application. */
export default class LawyerProfileCtrl {
  static async get(req: Request, res: Response) {
    res.status(200).json(await LawyerProfileSvc.get(req.user.userId));
  }

  static async update(req: Request, res: Response) {
    const country = await LawyerProfileSvc.countryOf(req.user.userId);
    const { error, value } = updateLawyerProfileSchema(country).validate(req.body, { stripUnknown: true });
    if (error) throw new HttpError(error.message, 400);
    value.registration = blanksToNull(value.registration);
    res.status(200).json(await LawyerProfileSvc.update(req.user.userId, value));
  }
}
