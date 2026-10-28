import type { Request, Response } from "express";
import type { ObjectSchema } from "joi";
import PracticeAreaSvc from "../services/practice-area.service";
import HttpError from "../utils/http-error";
import {
  createPracticeAreaSchema,
  practiceAreaListSchema,
  reorderPracticeAreasSchema,
  updatePracticeAreaSchema,
} from "../validation/practice-area.validation";

function validate<T>(schema: ObjectSchema<T>, input: unknown): T {
  const { error, value } = schema.validate(input ?? {});
  if (error) throw new HttpError(error.message, 400);
  return value;
}

/** The admin's Practice Area pages, one per site (PracticeAreaSvc). */
export default class PracticeAreaAdminCtrl {
  /** GET /api/admin/practice-areas?country=UK|PH — inactive ones too, with lawyerCount. */
  static async list(req: Request, res: Response) {
    res.status(200).json(await PracticeAreaSvc.listForAdmin(validate(practiceAreaListSchema, req.query).country));
  }

  /** POST /api/admin/practice-areas */
  static async create(req: Request, res: Response) {
    res.status(201).json(await PracticeAreaSvc.create(validate(createPracticeAreaSchema, req.body), req.user.userId));
  }

  /** PATCH /api/admin/practice-areas/:id — rename, map to a case area, or switch on/off. */
  static async update(req: Request, res: Response) {
    res.status(200).json(await PracticeAreaSvc.update(req.params.id, validate(updatePracticeAreaSchema, req.body), req.user.userId));
  }

  /** DELETE /api/admin/practice-areas/:id — only when no lawyer holds it (409 PRACTICE_AREA_IN_USE). */
  static async delete(req: Request, res: Response) {
    await PracticeAreaSvc.delete(req.params.id, req.user.userId);
    res.status(204).end();
  }

  /** POST /api/admin/practice-areas/reorder — every area on the site, in the new order. */
  static async reorder(req: Request, res: Response) {
    const { country, ids } = validate(reorderPracticeAreasSchema, req.body);
    res.status(200).json(await PracticeAreaSvc.reorder(country, ids, req.user.userId));
  }
}
