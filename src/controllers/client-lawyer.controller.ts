import { Request, Response } from "express";
import ClientLawyerSvc from "../services/client-lawyer.service";
import HttpError from "../utils/http-error";
import { clientLawyerIdSchema, listClientLawyersSchema, type ListClientLawyersQuery } from "../validation/client-lawyer.validation";

/** The client app's lawyer marketplace (/api/client/lawyers). */
export default class ClientLawyerCtrl {
  static async list(req: Request, res: Response) {
    const { error, value } = listClientLawyersSchema.validate(req.query, { stripUnknown: true, convert: true });
    if (error) throw new HttpError(error.message, 400);
    res.status(200).json(await ClientLawyerSvc.list(value as ListClientLawyersQuery));
  }

  static async get(req: Request, res: Response) {
    const { error, value } = clientLawyerIdSchema.validate(req.params, { stripUnknown: true });
    // Not a lawyer's id: no lawyer by it, as for one that isn't listed.
    if (error) throw new HttpError("That lawyer isn't listed.", 404, "LAWYER_NOT_FOUND");
    res.status(200).json(await ClientLawyerSvc.get(value.id));
  }
}
