import { Request, Response } from "express";
import EventSvc from "../services/event.service";
import HttpError from "../utils/http-error";
import prisma from "../lib/prisma";

async function getUserEmail(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  return user?.email ?? "";
}

export default class EventCtrl {
  static async list(req: Request, res: Response) {
    const { startRange, endRange, excludeId, excludeStatus, limitOne } = req.query;
    const email = await getUserEmail(req.user.userId);
    const events = await EventSvc.list(req.organization!.id, req.user.userId, email, {
      startRange: startRange as string | undefined,
      endRange: endRange as string | undefined,
      excludeId: excludeId as string | undefined,
      excludeStatus: excludeStatus as string | undefined,
      limitOne: limitOne === "true",
    });
    return res.status(200).json({ events });
  }

  static async getById(req: Request, res: Response) {
    const email = await getUserEmail(req.user.userId);
    const event = await EventSvc.getById(req.params.id, req.organization!.id, req.user.userId, email);
    return res.status(200).json({ event });
  }

  static async create(req: Request, res: Response) {
    const event = await EventSvc.create(req.organization!.id, req.user.userId, req.body);
    return res.status(201).json({ event });
  }

  static async updateById(req: Request, res: Response) {
    const email = await getUserEmail(req.user.userId);
    const result = await EventSvc.updateById(req.params.id, req.organization!.id, req.user.userId, email, req.body);
    return res.status(200).json(result);
  }

  static async updateByGoogleEventId(req: Request, res: Response) {
    const email = await getUserEmail(req.user.userId);
    const result = await EventSvc.updateByGoogleEventId(req.params.googleEventId, req.organization!.id, req.user.userId, email, req.body);
    return res.status(200).json(result);
  }

  static async deleteById(req: Request, res: Response) {
    await EventSvc.deleteById(req.params.id, req.organization!.id, req.user.userId);
    return res.status(204).send();
  }

  static async deleteByGoogleEventId(req: Request, res: Response) {
    await EventSvc.deleteByGoogleEventId(req.params.googleEventId, req.organization!.id, req.user.userId);
    return res.status(204).send();
  }
}
