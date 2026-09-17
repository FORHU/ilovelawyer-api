import { Request, Response } from "express";
import NoteSvc from "../services/note.service";

export default class NoteCtrl {
  static async list(req: Request, res: Response) {
    const { from, to } = req.query;
    const notes = await NoteSvc.list(req.organization!.id, req.user.userId, {
      from: from as string | undefined,
      to: to as string | undefined,
    });
    return res.status(200).json(notes);
  }

  static async create(req: Request, res: Response) {
    const note = await NoteSvc.create(req.organization!.id, req.user.userId, req.body);
    return res.status(201).json(note);
  }

  static async updateById(req: Request, res: Response) {
    const result = await NoteSvc.updateById(req.params.id, req.organization!.id, req.user.userId, req.body);
    return res.status(200).json(result);
  }

  static async deleteById(req: Request, res: Response) {
    await NoteSvc.deleteById(req.params.id, req.organization!.id, req.user.userId);
    return res.status(204).send();
  }
}
