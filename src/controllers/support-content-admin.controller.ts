import type { Request, Response } from "express";
import type { ObjectSchema } from "joi";
import SupportContentSvc from "../services/support-content.service";
import HttpError from "../utils/http-error";
import { supportVersionParamSchema, updateSupportDraftSchema } from "../validation/support-content.validation";

function validate<T>(schema: ObjectSchema<T>, input: unknown): T {
  const { error, value } = schema.validate(input ?? {});
  if (error) throw new HttpError(error.message, 400, "INVALID_SUPPORT_CONTENT");
  return value;
}

/** The admin's Support Chat editor (SupportContentSvc). */
export default class SupportContentAdminCtrl {
  /** GET /api/admin/support/content/draft */
  static async getDraft(_req: Request, res: Response) {
    res.status(200).json(await SupportContentSvc.getDraft());
  }

  /** PUT /api/admin/support/content/draft — 409 DRAFT_CONFLICT if it changed since expectedUpdatedAt. */
  static async updateDraft(req: Request, res: Response) {
    const { content, expectedUpdatedAt } = validate(updateSupportDraftSchema, req.body);
    res.status(200).json(await SupportContentSvc.updateDraft(content, expectedUpdatedAt, req.user.userId));
  }

  /** POST /api/admin/support/content/draft/validate */
  static async validateDraft(_req: Request, res: Response) {
    res.status(200).json(await SupportContentSvc.validateDraft());
  }

  /** POST /api/admin/support/content/publish — 422 SUPPORT_CONTENT_INVALID with the problems. */
  static async publish(req: Request, res: Response) {
    res.status(201).json(await SupportContentSvc.publish(req.user.userId));
  }

  /** GET /api/admin/support/content/versions */
  static async listVersions(_req: Request, res: Response) {
    res.status(200).json(await SupportContentSvc.listVersions());
  }

  /** GET /api/admin/support/content/versions/:version */
  static async getVersion(req: Request, res: Response) {
    const { version } = validate(supportVersionParamSchema, req.params);
    res.status(200).json(await SupportContentSvc.getVersion(version));
  }

  /** POST /api/admin/support/content/versions/:version/rollback */
  static async rollback(req: Request, res: Response) {
    const { version } = validate(supportVersionParamSchema, req.params);
    res.status(201).json(await SupportContentSvc.rollback(version, req.user.userId));
  }

  /** GET /api/admin/support/actions — the fixed Support Action catalog, for the editor's picker. */
  static async listActions(_req: Request, res: Response) {
    res.status(200).json(SupportContentSvc.listActions());
  }
}
