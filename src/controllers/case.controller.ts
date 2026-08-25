import { Request, Response } from "express";
import Joi from "joi";
import CaseSvc, { IncomingCaseDocument } from "../services/case.service";
import DocumentChunkSvc from "../services/document-chunk.service";
import HttpError from "../utils/http-error";
import { DOCUMENT_UPLOAD_BATCH_MAX } from "../constants/document-upload.constants";
import { PartyInput } from "../repositories/case.repository";

const ACTION_TYPES = ["Civil Litigation", "Criminal Proceeding", "Labor Dispute", "Commercial Arbitration"];
const PARTY_DESIGNATIONS = ["Petitioner / Plaintiff", "Respondent / Defendant", "Intervenor / Third-Party"];

const partySchema = Joi.object({
  name: Joi.string().required(),
  designation: Joi.string()
    .valid(...PARTY_DESIGNATIONS)
    .required(),
});

/** Converts legacy `"Name (Designation)"` into a parties array when `parties` is absent. */
function normalizeCaseBody(value: {
  partyInvolved?: string;
  parties?: PartyInput[];
  [key: string]: unknown;
}) {
  const { partyInvolved, ...rest } = value;
  if (rest.parties || !partyInvolved?.trim()) return rest;

  const trimmed = partyInvolved.trim();
  const match = trimmed.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  const parties: PartyInput[] = match
    ? [{ name: match[1].trim(), designation: match[2].trim() }]
    : [{ name: trimmed, designation: "Petitioner / Plaintiff" }];

  const { error, value: validatedParties } = Joi.array().items(partySchema).validate(parties);
  if (error) throw new HttpError(error.message, 400);

  return { ...rest, parties: validatedParties };
}

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

    const result = await CaseSvc.create(req.organization!.id, req.user.userId, normalizeCaseBody(value) as {
      caseName: string;
      actionType?: string;
      jurisdiction?: string;
      notes?: string;
      parties?: PartyInput[];
    });
    return res.status(201).json(result);
  }

  static async list(req: Request, res: Response) {
    const schema = Joi.object({
      page: Joi.number().integer().min(1).default(1),
      limit: Joi.number().integer().min(1).max(100).default(20),
      search: Joi.string().trim().allow("").optional(),
    });

    const { error, value } = schema.validate(req.query, { convert: true });
    if (error) throw new HttpError(error.message, 400);

    const result = await CaseSvc.list(req.organization!.id, value.page, value.limit, value.search);
    return res.status(200).json(result);
  }

  static async getById(req: Request, res: Response) {
    const result = await CaseSvc.getById(req.params.id, req.organization!.id);
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

    const result = await CaseSvc.update(req.params.id, req.organization!.id, normalizeCaseBody(value));
    return res.status(200).json(result);
  }

  static async delete(req: Request, res: Response) {
    await CaseSvc.delete(req.params.id, req.organization!.id);
    return res.status(204).send();
  }

  static async handleCreateCaseWithDocument(req: Request, res: Response) {

    const schema = Joi.object({
      caseId: Joi.string().required(),
      documentData: Joi.array().min(1).max(DOCUMENT_UPLOAD_BATCH_MAX).items(Joi.object({
        filename: Joi.string().required(),
        s3Key: Joi.string().required(),
        metaData: Joi.object({
          documentType: Joi.string().optional(),
          fileSize: Joi.number().integer().positive().required(),
          mimeType: Joi.string().required(),
        }).required(),
      })).required()
    });


    const input = {
      ...req.body,
      ...(req.params.caseId ? { caseId: String(req.params.caseId) } : {}),
    };

    const { error, value } = schema.validate(input);
    if (error) throw new HttpError(error.message, 400);

    const caseData: { caseId: string; organizationId: string; userId: string } = {
      caseId: value.caseId,
      organizationId: req.organization!.id,
      userId: req.user.userId,
    };

    const documentData: IncomingCaseDocument[] = value.documentData.map((doc: any) => ({
      filename: doc.filename,
      s3Key: doc.s3Key,
      metaData: doc.metaData,
    }));


    const result = await CaseSvc.handleCreateCaseWithDocument(caseData, documentData);
    return res.status(201).json(result);
  }

  /** Rank READY case-document chunks for a query — payload for chat-wonder case grounding. */
  static async relevantChunks(req: Request, res: Response) {
    const schema = Joi.object({
      query: Joi.string().trim().min(1).required(),
      limit: Joi.number().integer().min(1).max(100).default(20),
    });

    const { error, value } = schema.validate(req.body, { convert: true });
    if (error) throw new HttpError(error.message, 400);

    // Ownership check — throws 404 if the case is missing or not in this organization.
    await CaseSvc.getById(req.params.caseId, req.organization!.id);

    const result = await DocumentChunkSvc.relevantChunksForCase(
      req.params.caseId,
      value.query,
      value.limit,
    );
    return res.status(200).json(result);
  }
}
