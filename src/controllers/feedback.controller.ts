import { Request, Response } from "express";
import FeedbackSvc from "../services/feedback.service";
import HttpError from "../utils/http-error";
import { submitFeedbackSchema } from "../validation/feedback.validation";

export default class FeedbackCtrl {
  /** POST /api/feedback — signed-in users only. Deliberately not behind an organization header: feedback
   * is welcome from any page, including ones with no workspace selected. */
  static async submit(req: Request, res: Response) {
    const { error, value } = submitFeedbackSchema.validate(req.body, { stripUnknown: true });
    if (error) throw new HttpError(error.message, 400);

    const result = await FeedbackSvc.submit(req.user.userId, value, req.get("user-agent"));
    return res.status(201).json(result);
  }
}
