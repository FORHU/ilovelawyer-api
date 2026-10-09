import { Request, Response } from "express";
import CaseShareSvc from "../services/case-share.service";

/** Portfolio cases other people shared with the caller, read-only (see CaseShareSvc). */
export default class SharedCaseCtrl {
  static async list(req: Request, res: Response) {
    const result = await CaseShareSvc.listSharedWithMe(req.user.userId);
    return res.status(200).json(result);
  }

  static async leave(req: Request, res: Response) {
    await CaseShareSvc.leave(req.params.caseId, req.user.userId);
    return res.status(204).send();
  }
}
