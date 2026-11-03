import { Request, Response } from "express";
import ClientDictationSvc from "../services/client-dictation.service";
import HttpError from "../utils/http-error";

export default class ClientDictationCtrl {
  /** POST /api/client/dictations (multipart, field "audio") */
  static async start(req: Request, res: Response) {
    const file = req.file;
    if (!file) throw new HttpError("Attach a recording.", 400);
    res.status(202).json(await ClientDictationSvc.start(req.user.userId, file.buffer, file.mimetype));
  }

  /** GET /api/client/dictations/:id: IN_PROGRESS, or COMPLETED with the text, or FAILED. */
  static async result(req: Request, res: Response) {
    res.status(200).json(await ClientDictationSvc.result(req.user.userId, req.params.id));
  }
}
