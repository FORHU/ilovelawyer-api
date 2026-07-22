import { Request, Response } from "express";
import Joi from "joi";
import BookmarkSvc from "../services/bookmark.service";
import HttpError from "../utils/http-error";
import { BookmarkType } from "@prisma/client";

const bookmarkSchema = Joi.object({
  itemId: Joi.string().required(),
  title: Joi.string().required(),
  type: Joi.string().valid("case", "source").required(),
  reference: Joi.string().optional(),
  url: Joi.string().uri().optional(),
  aiSummary: Joi.string().optional(),
  doctrine: Joi.string().optional(),
  facts: Joi.string().optional(),
});

export default class BookmarkCtrl {
  static async create(req: Request, res: Response) {
    const { error, value } = bookmarkSchema.validate(req.body);
    if (error) throw new HttpError(error.message, 400);

    const bookmark = await BookmarkSvc.create(req.user.userId, {
      ...value,
      type: value.type as BookmarkType,
    });
    return res.status(201).json(bookmark);
  }

  static async list(req: Request, res: Response) {
    const bookmarks = await BookmarkSvc.list(req.user.userId);
    return res.status(200).json(bookmarks);
  }

  static async getById(req: Request, res: Response) {
    const bookmark = await BookmarkSvc.getById(req.params.id, req.user.userId);
    return res.status(200).json(bookmark);
  }

  static async checkByItemId(req: Request, res: Response) {
    const { itemId } = req.query;
    if (!itemId || typeof itemId !== "string") throw new HttpError("itemId query param is required", 400);
    const result = await BookmarkSvc.checkByItemId(req.user.userId, itemId);
    return res.status(200).json(result);
  }

  static async delete(req: Request, res: Response) {
    await BookmarkSvc.delete(req.params.id, req.user.userId);
    return res.status(204).send();
  }
}
