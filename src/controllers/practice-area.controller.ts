import type { Request, Response } from "express";
import PracticeAreaSvc from "../services/practice-area.service";
import HttpError from "../utils/http-error";
import { practiceAreaListSchema } from "../validation/practice-area.validation";

export default class PracticeAreaCtrl {
  /** GET /api/practice-areas?country=UK|PH — the lawyer app's picker: the site's active areas. */
  static async list(req: Request, res: Response) {
    const { error, value } = practiceAreaListSchema.validate(req.query);
    if (error) throw new HttpError(error.message, 400);
    res.status(200).json(await PracticeAreaSvc.listActive(value.country));
  }
}
