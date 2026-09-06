import { Request, Response } from "express";
import TerminalWorkspaceSvc from "../services/terminal-workspace.service";
import HttpError from "../utils/http-error";
import { createWorkspaceSchema, updateWorkspaceSchema, resetWorkspaceSchema } from "../validation/terminal-workspace.validation";

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
    const { error, value } = createWorkspaceSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const sku = await TerminalWorkspaceSvc.skuForUser(req.user.userId);
    const result = await TerminalWorkspaceSvc.create(req.user.userId, sku, value);
    return res.status(201).json(result);
  }

  static async update(req: Request, res: Response) {
    const { error, value } = updateWorkspaceSchema.validate(req.body);
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
    const { error, value } = resetWorkspaceSchema.validate(req.body ?? {});
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
