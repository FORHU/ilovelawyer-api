import { Request, Response, NextFunction } from "express";
import { CHAT_WONDER_API_KEY } from "../config";

/** Guards server-to-server routes called by Chat Wonder. Expects `x-api-key` to match CHAT_WONDER_API_KEY. */
const apiKeyMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey || typeof apiKey !== "string" || apiKey !== CHAT_WONDER_API_KEY) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
};

export default apiKeyMiddleware;
