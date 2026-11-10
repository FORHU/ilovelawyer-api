import type { ClientRequest, ClientRequestStatus } from "@prisma/client";
import ClientRequestRepo from "../repositories/client-request.repository";
import OrganizationRepo from "../repositories/organization.repository";
import WalletRepo from "../repositories/wallet.repository";
import EngagementAccessSvc from "./engagement-access.service";
import NotificationSvc from "./notification.service";
import PayoutSettingsSvc from "./payout-settings.service";
import ClientPricingSvc from "./client-pricing.service";
import SecurityAuditSvc from "./security-audit.service";
import WalletSvc from "./wallet.service";
import { emitToUser } from "../lib/socket";
import prisma from "../lib/prisma";
import { sendEmail } from "../utils/mailer";
import { renderTemplate } from "../utils/template";
import { emailLinkOriginForAccount } from "../utils/tenant-host";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";
import { ENGAGEMENT_COMPLETION_CONFIRM_DAYS } from "../constants/client-request.constants";
import type { ClientRequestUpdatedEvent, EngagementCompletion } from "../types/client-handoff";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The lawyer app's page for one request. */
const lawyerRequestPath = (requestId: string) => `/homepage/client-requests/${requestId}`;
const clientCaseLink = (caseId: string) => `${emailLinkOriginForAccount({ role: "USER" }, null)}/cases/${caseId}`;

/** UK date, as a UK client reads it: "Friday 20 November 2026". */
const ukDay = (date: Date) => date.toLocaleDateString("en-GB", { dateStyle: "full", timeZone: "Europe/London" });

/** When an ask made at `requestedAt` closes the engagement by itself, if the client doesn't answer. */
export function completionAutoClosesAt(requestedAt: Date): Date {
  return new Date(requestedAt.getTime() + ENGAGEMENT_COMPLETION_CONFIRM_DAYS * DAY_MS);
}

type CompletionFields = Pick<
  ClientRequest,
  "status" | "completionRequestedAt" | "completionNote" | "completionDeclinedAt" | "completionDeclineReason" | "completionConfirmedBy"
>;

/** EngagementCompletion in the contract, or null when the lawyer never said the work is finished. An
 * ask still open when the engagement closed some other way (the client ended it, or the lawyer
 * couldn't continue) no longer closes anything, so it has no `autoClosesAt`. */
export function completionDto(r: CompletionFields): EngagementCompletion | null {
  if (!r.completionRequestedAt && !r.completionDeclinedAt && !r.completionConfirmedBy) return null;
  const waiting = r.status === "ENGAGED" && !!r.completionRequestedAt;
  return {
    requestedAt: r.completionRequestedAt?.toISOString() ?? null,
    note: r.completionNote,
    autoClosesAt: waiting ? completionAutoClosesAt(r.completionRequestedAt!).toISOString() : null,
    declinedAt: r.completionDeclinedAt?.toISOString() ?? null,
    declineReason: r.completionDeclineReason,
    confirmedBy: r.completionConfirmedBy,
  };
}

/** The engaged lawyer of a request, from findForLawyer. */
function engagedOf(request: NonNullable<Awaited<ReturnType<typeof ClientRequestRepo.findForLawyer>>>) {
  return request.claims.find((c) => c.outcome === "ENGAGED") ?? null;
}

function updated(requestId: string, status: ClientRequestStatus, now: Date): ClientRequestUpdatedEvent {
  return { requestId, status, updatedAt: now.toISOString() };
}

/**
 * The lawyer's "the work is finished", which the client confirms. The lawyer asks (closing with
 * WORK_FINISHED): the engagement stays ENGAGED, the lawyer keeps their access, and the client is told
 * by bell and email. The client confirms, and it closes as the lawyer's close always did (closedBy
 * LAWYER, access removed, the earning's hold starting); or they say it isn't finished, with why, and
 * the lawyer carries on and can ask again. Nobody answering for ENGAGEMENT_COMPLETION_CONFIRM_DAYS
 * closes it by itself (ClientRequestSweepQueue), so a lawyer's fee is never held for good by a client
 * who went quiet. Either side can still end it some other way meanwhile: the client ends it, or the
 * lawyer finds they can't continue (a Lawyer Exit).
 */
export default class EngagementCompletionSvc {
  /** The lawyer asks the client to confirm. The caller has checked they're the lawyer engaged on it.
   * 409 COMPLETION_PENDING when they already asked; INVALID_REQUEST_STATUS when it's no longer engaged. */
  static async request(input: { requestId: string; caseId: string; clientId: string; lawyerId: string; lawyerName: string; note: string | null }, now: Date = new Date()) {
    const { requestId, caseId, clientId, lawyerId, note } = input;
    if (!(await ClientRequestRepo.requestCompletion(requestId, note, now))) {
      const current = await ClientRequestRepo.findForLawyer(requestId);
      if (current?.status === "ENGAGED") {
        throw new HttpError("You've already told the client the work is finished. It's waiting on them.", 409, "COMPLETION_PENDING");
      }
      throw new HttpError("This request isn't engaged.", 409, "INVALID_REQUEST_STATUS", { status: current?.status ?? "CLOSED" });
    }
    // The note is the lawyer's to the client, so it's fine in the case's activity feed.
    await OrganizationRepo.writeAudit({ caseId, actorId: lawyerId, action: "client_request.completion_requested", payload: { requestId, note } });
    emitToUser(clientId, "client-request:updated", updated(requestId, "ENGAGED", now));
    await EngagementCompletionSvc.tellClientAsked({ requestId, caseId, clientId, lawyerName: input.lawyerName, note, closesAt: completionAutoClosesAt(now) });
  }

  /** The client confirms the work is finished: the engagement closes. 409 COMPLETION_NOT_REQUESTED
   * when there's nothing to confirm. */
  static async confirm(clientId: string, requestId: string, now: Date = new Date()) {
    if (!(await EngagementCompletionSvc.finish(requestId, "CLIENT", now, clientId))) {
      await EngagementCompletionSvc.refuse(requestId);
    }
  }

  /** The client says the work isn't finished, and why: the lawyer is told and carries on. 409
   * COMPLETION_NOT_REQUESTED when there's nothing to answer. */
  static async decline(clientId: string, requestId: string, reason: string, now: Date = new Date()) {
    if (!(await ClientRequestRepo.declineCompletion(requestId, reason, now))) await EngagementCompletionSvc.refuse(requestId);
    const request = (await ClientRequestRepo.findForLawyer(requestId))!;
    const lawyer = engagedOf(request);
    await OrganizationRepo.writeAudit({ caseId: request.caseId, actorId: clientId, action: "client_request.completion_declined", payload: { requestId, reason } });
    if (!lawyer) return;
    emitToUser(lawyer.lawyerId, "client-request:updated", updated(requestId, "ENGAGED", now));
    await NotificationSvc.create({
      userId: lawyer.lawyerId,
      type: "CLIENT_REQUEST",
      title: "The client says the work isn't finished",
      message: reason,
      link: lawyerRequestPath(requestId),
    }).catch((err) => logger.error("Engagement completion: failed to create notification", { err, requestId }));
  }

  /** The sweep: engagements whose "the work is finished" nobody answered in time close by themselves.
   * How many closed. */
  static async closeDue(now: Date): Promise<number> {
    let closed = 0;
    const askedBy = new Date(now.getTime() - ENGAGEMENT_COMPLETION_CONFIRM_DAYS * DAY_MS);
    for (const { id } of await ClientRequestRepo.findCompletionDue(askedBy)) {
      try {
        if (await EngagementCompletionSvc.closeIfDue(id, now)) closed++;
      } catch (err) {
        logger.error("Engagement completion: closing by itself failed", { err, requestId: id });
      }
    }
    return closed;
  }

  /** One engagement, as the sweep sees it at `now`: closed by itself when its ask has gone unanswered
   * for ENGAGEMENT_COMPLETION_CONFIRM_DAYS. True when this call closed it. */
  static async closeIfDue(requestId: string, now: Date): Promise<boolean> {
    return EngagementCompletionSvc.finish(requestId, "AUTO", now);
  }

  /** Why there was nothing to confirm or decline: 409 COMPLETION_NOT_REQUESTED while it's engaged
   * with no open ask, INVALID_REQUEST_STATUS once it isn't engaged. */
  private static async refuse(requestId: string): Promise<never> {
    const current = await ClientRequestRepo.findForLawyer(requestId);
    if (current?.status === "ENGAGED") throw new HttpError("Your lawyer hasn't said the work is finished.", 409, "COMPLETION_NOT_REQUESTED");
    throw new HttpError("This engagement has already ended.", 409, "INVALID_REQUEST_STATUS", { status: current?.status ?? "CLOSED" });
  }

  /**
   * The open ask is confirmed (by the client, or AUTO): CLOSED as the lawyer's close (closedBy LAWYER),
   * once, in one transaction with the earning's hold starting now. The lawyer's access ends and both
   * sides are told; the client only when it closed by itself (they confirmed it otherwise). False when
   * there was no open ask, or it had already closed.
   */
  private static async finish(requestId: string, by: "CLIENT" | "AUTO", now: Date, clientId?: string): Promise<boolean> {
    const request = await ClientRequestRepo.findForLawyer(requestId);
    const lawyer = request ? engagedOf(request) : null;
    if (!request || !lawyer || request.status !== "ENGAGED" || !request.completionRequestedAt) return false;
    if (clientId && request.clientId !== clientId) return false;
    if (by === "AUTO" && completionAutoClosesAt(request.completionRequestedAt) > now) return false;
    const terms = await PayoutSettingsSvc.forTenant(await ClientPricingSvc.tenantIdForClient(request.clientId));
    const closed = await ClientRequestRepo.close(requestId, "LAWYER", now, {
      holdUntil: new Date(now.getTime() + terms.earningsHoldDays * DAY_MS),
      completion: { by, requestedAt: request.completionRequestedAt },
    });
    if (!closed.closed) return false;

    await EngagementAccessSvc.revoke({ requestId, caseId: request.caseId, lawyerId: lawyer.lawyerId });
    const payload = { requestId, closedBy: "LAWYER", outcome: "WORK_FINISHED", confirmedBy: by };
    const actorId = by === "CLIENT" ? request.clientId : null;
    await OrganizationRepo.writeAudit({ caseId: request.caseId, ...(actorId ? { actorId } : {}), action: "client_request.closed", payload });
    await SecurityAuditSvc.record({
      action: "client_request.closed",
      actorId,
      organizationId: lawyer.organizationId,
      targetType: "case",
      targetId: request.caseId,
      caseId: request.caseId,
      payload,
    });

    emitToUser(lawyer.lawyerId, "client-request:updated", updated(requestId, "CLOSED", now));
    emitToUser(request.clientId, "client-request:updated", updated(requestId, "CLOSED", now));
    await NotificationSvc.create({
      userId: lawyer.lawyerId,
      type: "CLIENT_REQUEST",
      title: by === "CLIENT" ? "The client confirmed the work is finished" : "Your engagement has closed",
      message:
        by === "CLIENT"
          ? "The engagement is closed. Your fee is released once the usual hold ends."
          : `The client didn't answer within ${ENGAGEMENT_COMPLETION_CONFIRM_DAYS} days, so the engagement closed as finished. Your fee is released once the usual hold ends.`,
      link: lawyerRequestPath(requestId),
    }).catch((err) => logger.error("Engagement completion: failed to create notification", { err, requestId }));
    if (by === "AUTO") await EngagementCompletionSvc.tellClientClosedByItself({ requestId, caseId: request.caseId, clientId: request.clientId, lawyerName: lawyer.lawyer.name ?? "" });
    for (const walletId of await WalletRepo.walletsForRequest(requestId)) await WalletSvc.changedById(walletId);
    return true;
  }

  /** The client is asked, by bell and email, to confirm the work is finished. Best effort. */
  private static async tellClientAsked(input: { requestId: string; caseId: string; clientId: string; lawyerName: string; note: string | null; closesAt: Date }) {
    const lawyer = input.lawyerName || "Your lawyer";
    const heading = `${lawyer} says the work on your case is finished`;
    const message = `${lawyer} has told us the work you hired them for is finished. Confirm it to close the engagement, or tell them what's left.`;
    const next = `If you don't answer by ${ukDay(input.closesAt)}, the engagement closes by itself.`;
    await EngagementCompletionSvc.tellClient(input, { heading, message, quote: input.note, next });
  }

  /** The client is told the engagement closed because they didn't answer. Best effort. */
  private static async tellClientClosedByItself(input: { requestId: string; caseId: string; clientId: string; lawyerName: string }) {
    const lawyer = input.lawyerName || "Your lawyer";
    const heading = `Your engagement with ${lawyer} has closed`;
    const message = `${lawyer} said the work was finished and we didn't hear back from you within ${ENGAGEMENT_COMPLETION_CONFIRM_DAYS} days, so the engagement has closed. They no longer have access to your case.`;
    await EngagementCompletionSvc.tellClient(input, { heading, message, quote: null, next: "You can rate your lawyer from your case." });
  }

  private static async tellClient(to: { requestId: string; caseId: string; clientId: string }, mail: { heading: string; message: string; quote: string | null; next: string }) {
    const said = mail.quote ? `Their note: "${mail.quote}"` : null;
    await NotificationSvc.create({
      userId: to.clientId,
      type: "CLIENT_REQUEST",
      title: mail.heading,
      message: [mail.message, mail.next].join(" "),
      link: `/cases/${to.caseId}`,
    }).catch((err) => logger.error("Engagement completion: failed to create notification", { err, requestId: to.requestId }));
    try {
      const client = await prisma.user.findUnique({ where: { id: to.clientId }, select: { email: true } });
      if (!client?.email) return;
      const caseLink = clientCaseLink(to.caseId);
      // The close email's layout: a heading, the message, an optional line, what's next, the case.
      const html = await renderTemplate("client-request-closed-client", { heading: mail.heading, message: mail.message, refund: said, next: mail.next, caseLink });
      const text = [mail.message, said, mail.next, caseLink].filter(Boolean).join("\n\n");
      await sendEmail({ to: client.email, subject: mail.heading, text, html });
    } catch (err) {
      logger.error("Engagement completion: email to the client failed", { err, requestId: to.requestId });
    }
  }
}
