import ClientRequestRepo from "../repositories/client-request.repository";
import ClientRequestClaimRepo from "../repositories/client-request-claim.repository";
import LawyerProfileRepo from "../repositories/lawyer-profile.repository";
import ClientRequestMatchingSvc from "./client-request-matching.service";
import NotificationSvc from "./notification.service";
import { emitToUser } from "../lib/socket";
import { sendEmail } from "../utils/mailer";
import { renderTemplate } from "../utils/template";
import { emailLinkOriginForAccount } from "../utils/tenant-host";
import { OPS_ALERT_EMAILS } from "../config";
import logger from "../utils/logger";
import CaseAreaSvc from "./case-area.service";
import type { ClientRequestClaimExpiringEvent, ClientRequestNewEvent, ClientRequestTakenEvent, ClientRequestUpdatedEvent, RequestUrgency, UkJurisdiction } from "../types/client-handoff";

/** The lawyer app's Client Requests page (ilovelawyer-app homepage/client-requests). */
const LAWYER_INBOX_PATH = "/homepage/client-requests";

const URGENCY_LABELS: Record<RequestUrgency, string> = {
  ROUTINE: "Routine",
  SOON: "Soon: a deadline within 30 days",
  URGENT: "Urgent: a deadline within 7 days",
};

/** "Employment, Consumer" */
const areasLabel = (names: string[]) => names.join(", ") || "Other";

/** UK time, as a UK lawyer or client reads it: "Friday 23 October 2026 at 10:00". */
function formatUk(date: Date): string {
  return date.toLocaleString("en-GB", { dateStyle: "full", timeStyle: "short", timeZone: "Europe/London" });
}

/** Links in a lawyer's email open on the UK lawyer app; in a client's, on the client app. */
const lawyerInboxLink = () => `${emailLinkOriginForAccount({ role: "LAWYER", tenant: { code: "UK" } }, null)}${LAWYER_INBOX_PATH}`;
const clientCaseLink = (caseId: string) => `${emailLinkOriginForAccount({ role: "USER" }, null)}/cases/${caseId}`;

function logFailures(results: PromiseSettledResult<unknown>[], message: string, context: Record<string, unknown>) {
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed.length) logger.error(message, { ...context, failed: failed.length, err: failed[0]!.reason });
}

/**
 * Telling people about client requests (#510). A request is announced to the lawyers it matches
 * once its brief is written; one nobody claims within 48h of routing expires, and ops get a digest;
 * a lawyer holding one is reminded 2h before their hold ends. Each first takes a guarded update
 * (announcedAt, EXPIRED, reminderSentAt) and only then sends, so overlapping runs never send the
 * same thing twice. Sending is best effort: a failed email is logged, not retried.
 * ClientRequestSweepQueue runs the timed parts every minute.
 */
export default class ClientRequestNotifySvc {
  /** Tells every lawyer matching the request about it: live, in the bell and by email. The number
   * told, or 0 when it was already announced or isn't routed with a brief yet. */
  static async announce(requestId: string, now: Date = new Date()): Promise<number> {
    if (!(await ClientRequestRepo.claimAnnouncement(requestId, now))) return 0;
    const request = await ClientRequestRepo.findForAnnouncement(requestId);
    if (!request?.routingExpiresAt) return 0;

    const lawyerIds = await ClientRequestMatchingSvc.eligibleLawyerIds(requestId);
    if (lawyerIds.length === 0) return 0;
    const urgency = (request.brief as { urgency?: RequestUrgency } | null)?.urgency ?? "ROUTINE";
    const ukJurisdiction = request.case.ukJurisdiction ?? "";
    const caseAreas = (await CaseAreaSvc.refsOf(request.case.caseAreas)).map((a) => a.name);
    const event: ClientRequestNewEvent = {
      requestId,
      caseAreas,
      ukJurisdiction: ukJurisdiction as UkJurisdiction,
      urgency,
      routingExpiresAt: request.routingExpiresAt.toISOString(),
    };
    // The brief's summary stays behind sign-in: an email carries only what the inbox row shows.
    const practiceArea = areasLabel(caseAreas);
    const closes = formatUk(request.routingExpiresAt);
    const subject = `New client request: ${practiceArea}, ${ukJurisdiction}`;
    const html = await renderTemplate("client-request-new", { practiceArea, ukJurisdiction, urgency: URGENCY_LABELS[urgency], routingExpiresAt: closes, inboxLink: lawyerInboxLink() });
    const text = `A client request matches you: ${practiceArea}, ${ukJurisdiction}. Urgency: ${URGENCY_LABELS[urgency]}. Open to accept until ${closes}.\n\n${lawyerInboxLink()}`;
    const emails = new Map((await LawyerProfileRepo.findEmails(lawyerIds)).map((u) => [u.id, u.email]));

    const results = await Promise.allSettled(
      lawyerIds.map(async (userId) => {
        emitToUser(userId, "client-request:new", event);
        // No organizationId: the inbox is the lawyer's own, so this shows in whichever workspace they're in.
        await NotificationSvc.create({
          userId,
          type: "CLIENT_REQUEST",
          title: "New client request",
          message: `${practiceArea}, ${ukJurisdiction}. ${URGENCY_LABELS[urgency]}.`,
          link: LAWYER_INBOX_PATH,
        }).catch((err) => logger.error("Client request: failed to create notification", { err, requestId, userId }));
        const to = emails.get(userId);
        if (to) await sendEmail({ to, subject, text, html });
      }),
    );
    logFailures(results, "Client request: announcement email failed", { requestId });
    return lawyerIds.length;
  }

  /** Announces without holding up the caller: the brief has just been written (#508). */
  static announceInBackground(requestId: string): void {
    ClientRequestNotifySvc.announce(requestId).catch((err) => logger.error("Client request: announcement failed", { requestId, err }));
  }

  /** The sweep's backstop: every routed request nobody has been told about. How many were told. */
  static async announceDue(now: Date): Promise<number> {
    let announced = 0;
    for (const { id } of await ClientRequestRepo.findUnannounced(now)) {
      try {
        if ((await ClientRequestNotifySvc.announce(id, now)) > 0) announced++;
      } catch (err) {
        logger.error("Client request: announcement failed", { requestId: id, err });
      }
    }
    return announced;
  }

  /** Routed requests nobody claimed within 48h become EXPIRED. Their lawyers drop them, the
   * client is told they can ask again, and ops get one digest for the run. How many expired. */
  static async expireDue(now: Date): Promise<number> {
    const expired: { id: string; practiceArea: string; ukJurisdiction: string; routedAt: string; matchingLawyers: number }[] = [];
    const label = await CaseAreaSvc.labeller();
    for (const request of await ClientRequestRepo.findExpired(now)) {
      try {
        const notChosen = await ClientRequestRepo.expire(request.id, now);
        if (!notChosen) continue;
        // Several lawyers: lawyers quoted, but the client didn't pick one by the pick-by date.
        const unpicked = !!request.pickByAt && request.pickByAt <= now;
        const lawyerIds = await ClientRequestMatchingSvc.eligibleLawyerIds(request.id);
        const taken: ClientRequestTakenEvent = { requestId: request.id };
        for (const userId of lawyerIds) emitToUser(userId, "client-request:taken", taken);
        const updated: ClientRequestUpdatedEvent = { requestId: request.id, status: "EXPIRED", updatedAt: now.toISOString() };
        emitToUser(request.clientId, "client-request:updated", updated);
        // The lawyers who were on it: matching may no longer list them (a lawyer at capacity because
        // of this very claim doesn't match), so they're told directly.
        for (const lawyerId of notChosen) {
          emitToUser(lawyerId, "client-request:updated", updated);
          await NotificationSvc.create({
            userId: lawyerId,
            type: "CLIENT_REQUEST",
            title: "The client didn't choose a quote",
            message: "The client didn't pick a lawyer in time, so the request has closed. Nothing was charged to you.",
            link: "/client-requests?view=history",
          }).catch((err) => logger.error("Client request: failed to create notification", { err, requestId: request.id }));
        }
        await ClientRequestNotifySvc.tellClientExpired(request.client.email, request.caseId, unpicked).catch((err) =>
          logger.error("Client request: expiry email to the client failed", { err, requestId: request.id }),
        );
        // Ops hear about requests no lawyer took up, not ones the client let lapse.
        if (unpicked) continue;
        expired.push({
          id: request.id,
          practiceArea: areasLabel(label(request.case.caseAreas).map((a) => a.name)),
          ukJurisdiction: request.case.ukJurisdiction ?? "",
          routedAt: request.routedAt ? formatUk(request.routedAt) : "unknown",
          matchingLawyers: lawyerIds.length,
        });
      } catch (err) {
        logger.error("Client request: expiry failed", { requestId: request.id, err });
      }
    }
    if (expired.length) await ClientRequestNotifySvc.alertOps(expired);
    return expired.length;
  }

  /** Reminds each lawyer whose hold ends within 2h, once: live and by email. How many reminded. */
  static async remindDue(now: Date): Promise<number> {
    let reminded = 0;
    for (const claim of await ClientRequestClaimRepo.findDueReminders(now)) {
      try {
        if (!(await ClientRequestClaimRepo.markReminderSent(claim.id, now))) continue;
        const event: ClientRequestClaimExpiringEvent = { requestId: claim.requestId, claimExpiresAt: claim.expiresAt.toISOString() };
        emitToUser(claim.lawyerId, "client-request:claim-expiring", event);
        const ends = formatUk(claim.expiresAt);
        const html = await renderTemplate("client-request-claim-expiring", { claimExpiresAt: ends, inboxLink: lawyerInboxLink() });
        const text = `Your 24-hour hold on a client request ends at ${ends}. Send a quote before then, or it goes back to other lawyers.\n\n${lawyerInboxLink()}`;
        await sendEmail({ to: claim.lawyer.email, subject: "Your hold on a client request ends in 2 hours", text, html }).catch((err) =>
          logger.error("Client request: reminder email failed", { err, claimId: claim.id }),
        );
        reminded++;
      } catch (err) {
        logger.error("Client request: reminder failed", { claimId: claim.id, err });
      }
    }
    return reminded;
  }

  /** `unpicked`: lawyers quoted, but the client didn't pick one in time (several lawyers, phase 5). */
  private static async tellClientExpired(email: string, caseId: string, unpicked: boolean) {
    const caseLink = clientCaseLink(caseId);
    const heading = unpicked ? "Your lawyer request has closed" : "We couldn't find a lawyer this time";
    const reason = unpicked
      ? "You didn't choose one of the quotes within 7 days, so your request has closed."
      : "No lawyer accepted your request within 48 hours, so it has closed.";
    const html = await renderTemplate("client-request-expired-client", { caseLink, heading, reason });
    const text = `${reason} You can ask for a lawyer again from your case.\n\n${caseLink}`;
    await sendEmail({ to: email, subject: heading, text, html });
  }

  /** One email per run to OPS_ALERT_EMAILS. Always logged, so an unset address still leaves a trace. */
  private static async alertOps(expired: { id: string; practiceArea: string; ukJurisdiction: string; routedAt: string; matchingLawyers: number }[]) {
    logger.warn("Client requests expired unclaimed", { count: expired.length, requestIds: expired.map((r) => r.id) });
    if (OPS_ALERT_EMAILS.length === 0) return;
    const subject = expired.length === 1 ? "1 client request expired unclaimed" : `${expired.length} client requests expired unclaimed`;
    const html = await renderTemplate("client-request-expired-ops", { count: String(expired.length), requests: expired });
    const text = expired.map((r) => `${r.id}: ${r.practiceArea}, ${r.ukJurisdiction}, routed ${r.routedAt}, ${r.matchingLawyers} matching lawyers now`).join("\n");
    const results = await Promise.allSettled(OPS_ALERT_EMAILS.map((to) => sendEmail({ to, subject, text, html })));
    logFailures(results, "Client request: ops digest email failed", { count: expired.length });
  }
}
