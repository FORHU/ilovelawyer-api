import type { Request, Response } from "express";
import SupportContentSvc from "../services/support-content.service";

/** What clients read: the published Support Chat content for their audience. */
export default class SupportContentCtrl {
  /** GET /api/client/support/content — the signed-in menu (client accounts only). */
  static async forClient(_req: Request, res: Response) {
    res.setHeader("Cache-Control", "private, no-store");
    res.status(200).json(await SupportContentSvc.getPublished("SIGNED_IN"));
  }

  /** GET /api/support/content — the signed-out menu. No session; cacheable. */
  static async forVisitor(_req: Request, res: Response) {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.status(200).json(await SupportContentSvc.getPublished("SIGNED_OUT"));
  }
}
