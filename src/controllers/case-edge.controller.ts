import { Request, Response } from "express";
import CaseEdgeSvc from "../services/case-edge.service";
import HttpError from "../utils/http-error";
import { createCaseEdgeSchema } from "../validation/case-terminal.validation";

export default class CaseEdgeCtrl {
  static async list(req: Request, res: Response) {
    const result = await CaseEdgeSvc.list(req.params.caseId, req.user.userId);
    return res.status(200).json(result);
  }

  static async create(req: Request, res: Response) {
    const { error, value } = createCaseEdgeSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);
    const result = await CaseEdgeSvc.create(req.params.caseId, req.user.userId, value);
    return res.status(201).json(result);
  }

  static async delete(req: Request, res: Response) {
    await CaseEdgeSvc.delete(req.params.caseId, req.params.id, req.user.userId);
    return res.status(204).send();
  }
}
