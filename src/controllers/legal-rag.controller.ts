import { Request, Response } from "express";
import Joi from "joi";
import LegalRagSvc from "../services/legal-rag.service";
import HttpError from "../utils/http-error";
import { getTenantContext } from "../utils/tenant-context";
import { getLegalKnowledgeProvider } from "../legal/legal-knowledge.registry";

export default class LegalRagCtrl {
  static async categories(req: Request, res: Response) {
    const schema = Joi.object({ category: Joi.string().optional() });
    const { error, value } = schema.validate(req.query);
    if (error) throw new HttpError(error.message, 400);

    const provider = getLegalKnowledgeProvider(getTenantContext(req).tenantCode);

    if (value.category) {
      const subcategories = await provider.getSubcategories(value.category);
      return res.status(200).json({ subcategories });
    }

    const categories = await provider.getCategories();
    return res.status(200).json({ categories });
  }

  static async list(req: Request, res: Response) {
    const schema = Joi.object({
      page: Joi.number().integer().min(1).default(1),
      limit: Joi.number().integer().min(1).max(100).default(20),
      category: Joi.string().optional(),
      subcategory: Joi.string().optional(),
      noSubcategory: Joi.boolean().optional(),
      year: Joi.number().integer().optional(),
      search: Joi.string().optional(),
    });

    const { error, value } = schema.validate(req.query, { convert: true });
    if (error) throw new HttpError(error.message, 400);

    const provider = getLegalKnowledgeProvider(getTenantContext(req).tenantCode);
    const result = await provider.list(value);

    return res.status(200).json(result);
  }

  static async librarySections(req: Request, res: Response) {
    const provider = getLegalKnowledgeProvider(getTenantContext(req).tenantCode);
    const sections = await provider.getLibrarySections();
    return res.status(200).json({ sections });
  }

  static async vectorSearch(req: Request, res: Response) {
    const schema = Joi.object({
      embedding: Joi.array().items(Joi.number()).min(1).required(),
      limit: Joi.number().integer().min(1).max(100).default(10),
      offset: Joi.number().integer().min(0).default(0),
      minSimilarity: Joi.number().min(0).max(1).default(0.3),
    });

    const { error, value } = schema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);

    const provider = getLegalKnowledgeProvider(getTenantContext(req).tenantCode);
    const results = await provider.vectorSearch(value.embedding, value.limit, value.offset, value.minSimilarity);
    return res.status(200).json({ results });
  }

  static async getRelated(req: Request, res: Response) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new HttpError("Invalid case law document ID", 400);
    }

    const schema = Joi.object({
      limit: Joi.number().integer().min(1).max(20).default(5),
    });
    const { error, value } = schema.validate(req.query, { convert: true });
    if (error) throw new HttpError(error.message, 400);

    const provider = getLegalKnowledgeProvider(getTenantContext(req).tenantCode);
    const related = await provider.getRelated(id, value.limit);
    return res.status(200).json({ related });
  }

  static async formatDocument(req: Request, res: Response) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new HttpError("Invalid case law document ID", 400);
    }

    const schema = Joi.object({
      force: Joi.boolean().default(false),
      generate_title: Joi.boolean().default(true),
    });
    const { error, value } = schema.validate(req.query, { convert: true });
    if (error) throw new HttpError(error.message, 400);

    const data = await LegalRagSvc.formatDocument(id, { force: value.force, generateTitle: value.generate_title });
    return res.status(200).json(data);
  }

  static async formatDocuments(req: Request, res: Response) {
    const schema = Joi.object({
      force: Joi.boolean().default(false),
      all: Joi.boolean().default(false),
      generate_title: Joi.boolean().default(true),
      limit: Joi.number().integer().min(1).optional(),
      delay: Joi.number().min(0).optional(),
    });
    const { error, value } = schema.validate(req.query, { convert: true });
    if (error) throw new HttpError(error.message, 400);

    const data = await LegalRagSvc.formatDocuments({
      force: value.force,
      all: value.all,
      generateTitle: value.generate_title,
      limit: value.limit,
      delay: value.delay,
    });
    return res.status(200).json(data);
  }

  static async getById(req: Request, res: Response) {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new HttpError("Invalid case law document ID", 400);
    }

    const provider = getLegalKnowledgeProvider(getTenantContext(req).tenantCode);
    const doc = await provider.getById(id);
    return res.status(200).json(doc);
  }

  static async getSourcePageDoc(req: Request, res: Response) {
    const { itemId } = req.params;
    const titleHint = typeof req.query.title === "string" ? req.query.title.trim() : undefined;
    const provider = getLegalKnowledgeProvider(getTenantContext(req).tenantCode);
    const doc = await provider.getSourcePageDoc(itemId, titleHint);
    return res.status(200).json(doc);
  }

  static async search(req: Request, res: Response) {
    const schema = Joi.object({
      q: Joi.string().min(2).required(),
      limit: Joi.number().integer().min(1).max(20).default(5),
    });

    const { error, value } = schema.validate(req.query, { convert: true });
    if (error) throw new HttpError(error.message, 400);

    const provider = getLegalKnowledgeProvider(getTenantContext(req).tenantCode);
    const results = await provider.search(value.q, value.limit);
    return res.status(200).json(results);
  }
}
