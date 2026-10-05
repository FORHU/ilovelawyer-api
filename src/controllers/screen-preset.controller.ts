import { Request, Response } from "express";
import ScreenPresetSvc from "../services/screen-preset.service";
import HttpError from "../utils/http-error";
import { createScreenPresetSchema, updateScreenPresetSchema } from "../validation/screen-preset.validation";

export default class ScreenPresetCtrl {
  static async list(req: Request, res: Response) {
    const raw = req.query.screenCount;
    const screenCount = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : undefined;
    if (screenCount !== undefined && !Number.isInteger(screenCount)) throw new HttpError("screenCount must be an integer", 400);
    const result = await ScreenPresetSvc.list(req.user.userId, screenCount);
    return res.status(200).json(result);
  }

  static async create(req: Request, res: Response) {
    const { error, value } = createScreenPresetSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const result = await ScreenPresetSvc.create(req.user.userId, value);
    return res.status(201).json(result);
  }

  static async update(req: Request, res: Response) {
    const { error, value } = updateScreenPresetSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const result = await ScreenPresetSvc.update(req.params.id, req.user.userId, value);
    return res.status(200).json(result);
  }

  static async delete(req: Request, res: Response) {
    await ScreenPresetSvc.delete(req.params.id, req.user.userId);
    return res.status(204).send();
  }
}
