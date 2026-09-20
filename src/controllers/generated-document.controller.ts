import { Request, Response } from "express";
import GeneratedDocumentExportSvc, { GeneratedDocumentFormat } from "../services/generated-document-export.service";
import { createGeneratedDocumentSchema } from "../validation/generated-document.validation";
import HttpError from "../utils/http-error";

export default class GeneratedDocumentCtrl {
  static async create(req: Request, res: Response) {
    const { error, value } = createGeneratedDocumentSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);

    // GeneratedDocumentExportSvc.export takes (content, documentName, format) — content first,
    // matching CaseBriefExportSvc's "what to render" argument leading and format trailing last.
    const result = await GeneratedDocumentExportSvc.export(value.content, value.documentName, value.format as GeneratedDocumentFormat);

    return res.status(201).json(result);
  }
}
