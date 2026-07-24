import { Request, Response } from "express";
import Joi from "joi";
import CaseSvc from "../services/case.service";
import HttpError from "../utils/http-error";

const ACTION_TYPES = ["Civil Litigation", "Criminal Proceeding", "Labor Dispute", "Commercial Arbitration"];
const PARTY_DESIGNATIONS = ["Petitioner / Plaintiff", "Respondent / Defendant", "Intervenor / Third-Party"];

const partySchema = Joi.object({
  name: Joi.string().required(),
  designation: Joi.string()
    .valid(...PARTY_DESIGNATIONS)
    .required(),
});

export default class CaseCtrl {
  static async create(req: Request, res: Response) {
    const schema = Joi.object({
      caseName: Joi.string().required(),
      partyInvolved: Joi.string().allow("").optional(),
      actionType: Joi.string()
        .valid(...ACTION_TYPES)
        .optional(),
      jurisdiction: Joi.string().allow("").optional(),
      notes: Joi.string().allow("").optional(),
      parties: Joi.array().items(partySchema).optional(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);

    const result = await CaseSvc.create(req.user.userId, value);
    return res.status(201).json(result);
  }

  static async list(req: Request, res: Response) {
    const schema = Joi.object({
      page: Joi.number().integer().min(1).default(1),
      limit: Joi.number().integer().min(1).max(100).default(20),
    });

    const { error, value } = schema.validate(req.query, { convert: true });
    if (error) throw new HttpError(error.message, 400);

    const result = await CaseSvc.list(req.user.userId, value.page, value.limit);
    return res.status(200).json(result);
  }

  static async getById(req: Request, res: Response) {
    const result = await CaseSvc.getById(req.params.id, req.user.userId);
    return res.status(200).json(result);
  }

  static async update(req: Request, res: Response) {
    const schema = Joi.object({
      caseName: Joi.string().optional(),
      partyInvolved: Joi.string().allow("").optional(),
      actionType: Joi.string()
        .valid(...ACTION_TYPES)
        .optional(),
      jurisdiction: Joi.string().allow("").optional(),
      notes: Joi.string().allow("").optional(),
      parties: Joi.array().items(partySchema).optional(),
    }).min(1);

    const { error, value } = schema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);

    const result = await CaseSvc.update(req.params.id, req.user.userId, value);
    return res.status(200).json(result);
  }

  static async delete(req: Request, res: Response) {
    await CaseSvc.delete(req.params.id, req.user.userId);
    return res.status(204).send();
  }
}
