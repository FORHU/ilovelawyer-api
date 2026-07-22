import { Request, Response } from "express";
import ParticipantSvc from "../services/participant.service";

export default class ParticipantCtrl {
  static async list(req: Request, res: Response) {
    const participants = await ParticipantSvc.list(req.user.userId, req.params.conversationId);
    return res.status(200).json(participants);
  }

  static async remove(req: Request, res: Response) {
    await ParticipantSvc.remove(req.user.userId, req.params.conversationId, req.params.userId);
    return res.status(204).send();
  }
}
