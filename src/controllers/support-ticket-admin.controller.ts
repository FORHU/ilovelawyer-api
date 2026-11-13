import type { Request, Response } from "express";
import SupportTicketSvc from "../services/support-ticket.service";
import SupportOutcomeSvc from "../services/support-outcome.service";
import { validateInput } from "../utils/validate-input";
import { adminReplySchema, adminTicketListSchema, supportReportSchema } from "../validation/support-ticket.validation";

/** The admin's Support Tickets inbox and outcome report. */
export default class SupportTicketAdminCtrl {
  /** GET /api/admin/support/tickets?status=&q=&sort=age|updated&page= */
  static async list(req: Request, res: Response) {
    res.status(200).json(await SupportTicketSvc.adminList(validateInput(adminTicketListSchema, req.query)));
  }

  /** GET /api/admin/support/tickets/:id */
  static async get(req: Request, res: Response) {
    res.status(200).json(await SupportTicketSvc.adminGet(req.params.id));
  }

  /** POST /api/admin/support/tickets/:id/replies */
  static async reply(req: Request, res: Response) {
    const { body } = validateInput(adminReplySchema, req.body);
    res.status(201).json(await SupportTicketSvc.adminReply(req.params.id, req.user.userId, body));
  }

  /** POST /api/admin/support/tickets/:id/resolve */
  static async resolve(req: Request, res: Response) {
    res.status(200).json(await SupportTicketSvc.resolve(req.params.id, req.user.userId));
  }

  /** POST /api/admin/support/tickets/:id/reopen */
  static async reopen(req: Request, res: Response) {
    res.status(200).json(await SupportTicketSvc.reopen(req.params.id, req.user.userId));
  }

  /** GET /api/admin/support/report?from=&to= — `to` is exclusive. */
  static async report(req: Request, res: Response) {
    const { from, to } = validateInput(supportReportSchema, req.query, "INVALID_RANGE");
    res.status(200).json(await SupportOutcomeSvc.report(from, to));
  }
}
