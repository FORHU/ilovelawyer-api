import type { Request, Response } from "express";
import type { ObjectSchema } from "joi";
import CaseAreaSvc from "../services/case-area.service";
import HttpError from "../utils/http-error";
import { caseAreaListSchema, createCaseAreaSchema, reorderCaseAreasSchema, updateCaseAreaSchema } from "../validation/case-area.validation";

function validate<T>(schema: ObjectSchema<T>, input: unknown): T {
  const { error, value } = schema.validate(input ?? {});
  if (error) throw new HttpError(error.message, 400);
  return value;
}

/** The admin's Client case types page (CaseAreaSvc). */
export default class CaseAreaAdminCtrl {
  /** GET /api/admin/case-areas?country=UK — switched-off ones too, with caseCount and practiceAreaCount. */
  static async list(req: Request, res: Response) {
    res.status(200).json(await CaseAreaSvc.listForAdmin(validate(caseAreaListSchema, req.query).country));
  }

  /** POST /api/admin/case-areas */
  static async create(req: Request, res: Response) {
    res.status(201).json(await CaseAreaSvc.create(validate(createCaseAreaSchema, req.body), req.user.userId));
  }

  /** PATCH /api/admin/case-areas/:id — rename, redescribe, or switch on/off. */
  static async update(req: Request, res: Response) {
    res.status(200).json(await CaseAreaSvc.update(req.params.id, validate(updateCaseAreaSchema, req.body), req.user.userId));
  }

  /** DELETE /api/admin/case-areas/:id — only when nothing uses it (409 CASE_AREA_IN_USE). */
  static async delete(req: Request, res: Response) {
    await CaseAreaSvc.delete(req.params.id, req.user.userId);
    res.status(204).end();
  }

  /** POST /api/admin/case-areas/reorder — every area on the site, in the new order. */
  static async reorder(req: Request, res: Response) {
    const { country, ids } = validate(reorderCaseAreasSchema, req.body);
    res.status(200).json(await CaseAreaSvc.reorder(country, ids, req.user.userId));
  }
}
