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

  /** Called server-to-server by ilovelawyer-app's /files/[token] Route Handler — never by the
   * browser directly, so there's no user session here; the token itself is the auth. */
  static async resolve(req: Request, res: Response) {
    const token = req.query.token;
    if (typeof token !== "string" || !token) {
      throw new HttpError("Not found", 404);
    }

    const url = await FilesSvc.resolve(token);
    return res.status(200).json({ url });
  }
}
