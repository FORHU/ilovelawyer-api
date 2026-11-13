import type { NextFunction, Request, Response } from "express";
import SupportTicketSvc from "../services/support-ticket.service";
import SupportOutcomeSvc from "../services/support-outcome.service";
import { clientWorkspaceOf } from "../middleware/require-client-account.middleware";
import { verifyTurnstile } from "../utils/turnstile";
import { validateInput } from "../utils/validate-input";
import HttpError from "../utils/http-error";
import { clientTicketMessageSchema, outcomesSchema, visitorTicketSchema } from "../validation/support-ticket.validation";

/** What a client or a visitor does with the Support Chat's ticket and outcome endpoints. */
export default class SupportTicketCtrl {
  /** GET /api/client/support/ticket — the open (or latest) thread, or null. */
  static async getThread(req: Request, res: Response) {
    res.status(200).json(await SupportTicketSvc.getThread(req.user.userId));
  }

  /** POST /api/client/support/ticket/messages — also opens the ticket (the OPEN_TICKET action). */
  static async postMessage(req: Request, res: Response) {
    const input = validateInput(clientTicketMessageSchema, req.body);
    res.status(201).json(await SupportTicketSvc.postClientMessage({ userId: req.user.userId, workspaceId: clientWorkspaceOf(req).id }, input));
  }

  /** POST /api/client/support/ticket/read */
  static async markRead(req: Request, res: Response) {
    await SupportTicketSvc.markRead(req.user.userId);
    res.status(204).end();
  }

  /** POST /api/client/support/outcomes and POST /api/support/outcomes */
  static async recordOutcomes(req: Request, res: Response) {
    const { events } = validateInput(outcomesSchema, req.body);
    await SupportOutcomeSvc.record(events);
    res.status(204).end();
  }

  /** The first step of POST /api/support/tickets: the body, then the captcha, before anything is counted against the address. */
  static async checkVisitorTicket(req: Request, res: Response, next: NextFunction) {
    const input = validateInput(visitorTicketSchema, req.body);
    if (!(await verifyTurnstile(input.turnstileToken || undefined, req.ip))) {
      throw new HttpError("We couldn't check that you're not a robot. Please try again.", 400, "CAPTCHA_FAILED");
    }
    res.locals.visitorTicket = input;
    next();
  }

  /** POST /api/support/tickets — always 202, whether or not the email has an account. */
  static async openVisitorTicket(_req: Request, res: Response) {
    const { email, message, context } = res.locals.visitorTicket;
    await SupportTicketSvc.openSignedOut({ email, message, context });
    res.status(202).json({ ok: true });
  }
}
