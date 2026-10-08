import { NextFunction, Request, Response } from "express";
import { withRequestContextOf } from "../lib/request-context";

type AsyncRouteHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

export default function asyncHandler(handler: AsyncRouteHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Re-enters this request's context in case a stream-based middleware before it (multer)
    // called next() from outside it — see request-context.ts.
    withRequestContextOf(req, () => handler(req, res, next)).catch(next);
  };
}
