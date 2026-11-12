import type { Request, Response } from "express";
import SupportActionSvc from "../services/support-action.service";
import { clientWorkspaceOf } from "../middleware/require-client-account.middleware";
import { requestFrontendOrigin } from "../utils/tenant-host";
import HttpError from "../utils/http-error";
import { visitorActionSchema } from "../validation/support-action.validation";

/** The Support Chat's actions (SupportActionSvc). */
export default class SupportActionCtrl {
  /** GET /api/client/support/actions/deletion-check */
  static async deletionCheck(req: Request, res: Response) {
    res.status(200).json(await SupportActionSvc.deletionCheck(req.user.userId, clientWorkspaceOf(req).id));
  }

  /** POST /api/client/support/actions/:key */
  static async run(req: Request, res: Response) {
    const key = SupportActionSvc.clientAction(req.params.key);
    const result = await SupportActionSvc.run(key, {
      userId: req.user.userId,
      workspaceId: clientWorkspaceOf(req).id,
      origin: requestFrontendOrigin(req),
    });
    res.status(200).json(result);
  }

  /** POST /api/support/actions/:key — no session. Always { ok: true }, whether or not the email has an account. */
  static async runForVisitor(req: Request, res: Response) {
    const key = SupportActionSvc.visitorAction(req.params.key);
    const { error, value } = visitorActionSchema.validate(req.body ?? {});
    if (error) throw new HttpError(error.message, 400);
    res.status(200).json(SupportActionSvc.requestForVisitor(key, value.email, requestFrontendOrigin(req)));
  }
}
