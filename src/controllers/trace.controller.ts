import { Request, Response } from "express";
import TraceSvc from "../services/trace.service";
import HttpError from "../utils/http-error";

export default class TraceCtrl {
  /** GET /my-cases/:caseId/trace/turns?userId= — the pager's turn list; `userId` filters by member. */
  static async listTurns(req: Request, res: Response) {
    const memberId = typeof req.query.userId === "string" && req.query.userId ? req.query.userId : undefined;
    const turns = await TraceSvc.listTurns(req.params.caseId, req.user.userId, memberId);
    return res.status(200).json({ turns });
  }

  /** GET /my-cases/:caseId/trace/turns/:turnId?after=<seq> — one turn's events (only newer than `after`). */
  static async listTurnEvents(req: Request, res: Response) {
    const after = req.query.after === undefined ? 0 : Number(req.query.after);
    if (!Number.isInteger(after) || after < 0) throw new HttpError("`after` must be a non-negative integer", 400);
    const events = await TraceSvc.listTurnEvents(req.params.caseId, req.user.userId, req.params.turnId, after);
    return res.status(200).json({ events });
  }
}
