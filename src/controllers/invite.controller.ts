import { Request, Response } from "express";
import InviteSvc from "../services/invite.service";

export default class InviteCtrl {
  static async create(req: Request, res: Response) {
    const invite = await InviteSvc.create(req.user.userId, req.params.consultationId);
    return res.status(201).json(invite);
  }

  static async getById(req: Request, res: Response) {
    const invite = await InviteSvc.getById(req.params.id);
    return res.status(200).json(invite);
  }

  static async listByConsultation(req: Request, res: Response) {
    const invites = await InviteSvc.listByConsultation(req.user.userId, req.params.consultationId);
    return res.status(200).json(invites);
  }

  static async accept(req: Request, res: Response) {
    const result = await InviteSvc.accept(req.user.userId, req.params.id);
    return res.status(200).json(result);
  }

  static async delete(req: Request, res: Response) {
    await InviteSvc.delete(req.user.userId, req.params.id);
    return res.status(204).send();
  }
}
