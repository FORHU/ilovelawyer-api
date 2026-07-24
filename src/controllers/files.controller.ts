import { Request, Response } from "express";
import FilesSvc from "../services/files.service";
import HttpError from "../utils/http-error";

export default class FilesCtrl {
  static async upload(req: Request, res: Response) {
    if (!req.file) {
      throw new HttpError("No file provided", 400);
    }

    const file = await FilesSvc.upload(req.file.originalname, req.file.buffer, req.file.mimetype);

    return res.status(201).json(file);
  }
}
