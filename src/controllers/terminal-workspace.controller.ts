import { Request, Response } from "express";
import Joi from "joi";
import TerminalWorkspaceSvc from "../services/terminal-workspace.service";
import HttpError from "../utils/http-error";

const PRESETS = ["PANE_1", "PANE_2", "PANE_4", "PANE_6"] as const;

export default class TerminalWorkspaceCtrl {
  static async catalog(req: Request, res: Response) {
    const sku = await TerminalWorkspaceSvc.skuForUser(req.user.userId);
    return res.status(200).json(TerminalWorkspaceSvc.catalog(sku));
  }

  static async metrics(req: Request, res: Response) {
    const result = await TerminalWorkspaceSvc.metrics(req.user.userId);
    return res.status(200).json(result);
  }

  static async list(req: Request, res: Response) {
    const result = await TerminalWorkspaceSvc.list(req.user.userId);
    return res.status(200).json(result);
  }

  static async getById(req: Request, res: Response) {
    const result = await TerminalWorkspaceSvc.getById(req.params.id, req.user.userId);
    return res.status(200).json(result);
  }

  static async create(req: Request, res: Response) {
    const schema = Joi.object({
      name: Joi.string().trim().min(1).max(120).required(),
      preset: Joi.string().valid(...PRESETS).optional(),
      layoutJson: Joi.object().optional(),
    });
    const { error, value } = schema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const sku = await TerminalWorkspaceSvc.skuForUser(req.user.userId);
    const result = await TerminalWorkspaceSvc.create(req.user.userId, sku, value);
    return res.status(201).json(result);
  }

  static async update(req: Request, res: Response) {
    const schema = Joi.object({
      name: Joi.string().trim().min(1).max(120).optional(),
      preset: Joi.string().valid(...PRESETS).optional(),
      layoutJson: Joi.object().optional(),
      isLastUsed: Joi.boolean().optional(),
    }).min(1);
    const { error, value } = schema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const sku = await TerminalWorkspaceSvc.skuForUser(req.user.userId);
    const result = await TerminalWorkspaceSvc.update(req.params.id, req.user.userId, sku, value);
    return res.status(200).json(result);
  }

  static async apply(req: Request, res: Response) {
    const result = await TerminalWorkspaceSvc.apply(req.params.id, req.user.userId);
    return res.status(200).json(result);
  }

  static async reset(req: Request, res: Response) {
    const schema = Joi.object({
      preset: Joi.string().valid(...PRESETS).optional(),
    });
    const { error, value } = schema.validate(req.body ?? {});
    if (error) throw new HttpError(error.message, 400);
    const sku = await TerminalWorkspaceSvc.skuForUser(req.user.userId);
    const result = await TerminalWorkspaceSvc.resetToPreset(req.user.userId, sku, value.preset);
    return res.status(201).json(result);
  }

  static async delete(req: Request, res: Response) {
    await TerminalWorkspaceSvc.delete(req.params.id, req.user.userId);
    return res.status(204).send();
  }
}
