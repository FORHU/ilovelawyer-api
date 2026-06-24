import { NextFunction, Request, Response } from "express";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";

export default function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.statusCode).json({ message: err.message });
  }

  logger.error(err instanceof Error ? err.message : "Unknown error", { err });
  return res.status(500).json({ message: "Internal server error" });
}
