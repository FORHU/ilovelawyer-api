import { NextFunction, Request, Response } from "express";
import { MulterError } from "multer";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";

export default function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  // Headers already went out (e.g. a chat stream failed mid-response) — a chunked
  // response can't have a fresh .json() layered on top of it. Just close the
  // connection cleanly instead of throwing ERR_HTTP_HEADERS_SENT.
  if (res.headersSent) {
    logger.error(err instanceof Error ? err.message : "Unknown error (post-headers)", { err });
    return res.end();
  }

  if (err instanceof HttpError) {
    return res.status(err.statusCode).json({ message: err.message });
  }

  // Multer throws its own error type (not an HttpError) when it rejects an upload
  // (e.g. LIMIT_FILE_SIZE) — without this, a too-large recording gets reported
  // to the user as an opaque "Internal server error" instead of the real reason.
  if (err instanceof MulterError) {
    const statusCode = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    return res.status(statusCode).json({ message: err.message });
  }

  logger.error(err instanceof Error ? err.message : "Unknown error", { err });
  return res.status(500).json({ message: "Internal server error" });
}
