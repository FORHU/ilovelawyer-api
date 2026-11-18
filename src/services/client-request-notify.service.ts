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
import { moneyText } from "../utils/money-text";
import prisma from "../lib/prisma";
import CaseAreaSvc from "./case-area.service";
import type {
  ClientRequestClaimExpiringEvent,
  ClientRequestDeletedEvent,
  ClientRequestNewEvent,
  ClientRequestTakenEvent,
  ClientRequestUpdatedEvent,
  RequestUrgency,
  UkJurisdiction,
} from "../types/client-handoff";

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

/** Links in a lawyer's email open on their own site's lawyer app; in a client's, on their own site's
 * client app. */
const lawyerInboxLink = (site: string = "UK") => `${emailLinkOriginForAccount({ role: "LAWYER", tenant: { code: site } }, null)}${LAWYER_INBOX_PATH}`;
const clientCaseLink = (caseId: string, site: string = "UK") => `${emailLinkOriginForAccount({ role: "USER", tenant: { code: site } }, null)}/cases/${caseId}`;

/** Korea's time, as a KR lawyer or client reads it: "2026년 10월 23일 금요일 오후 7:00". */
function formatKr(date: Date): string {
  return date.toLocaleString("ko-KR", { dateStyle: "full", timeStyle: "short", timeZone: "Asia/Seoul" });
}

const URGENCY_LABELS_KO: Record<RequestUrgency, string> = { URGENT: "긴급", SOON: "곧 기한 도래", ROUTINE: "일반" };

/** A user's site: their organization's, else their own (UK when neither says). */
async function siteOfUser(userId: string): Promise<string> {
  return (await LawyerProfileRepo.findLawyerTenant(userId))?.tenantCode ?? "UK";
}

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
    const site = request.client?.tenant?.code ?? "UK";
    if (site === "KR") return ClientRequestNotifySvc.announceKr(request, lawyerIds);
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
    // Sent to one lawyer by name: matching has only them (onlyLawyerOf).
    const askedForYou = request.requestedOnly;
    const subject = askedForYou ? `A client asked for you: ${practiceArea}, ${ukJurisdiction}` : `New client request: ${practiceArea}, ${ukJurisdiction}`;
    const html = await renderTemplate("client-request-new", { askedForYou, practiceArea, ukJurisdiction, urgency: URGENCY_LABELS[urgency], routingExpiresAt: closes, inboxLink: lawyerInboxLink() });
    const text = askedForYou
      ? `A client asked for you: ${practiceArea}, ${ukJurisdiction}. Urgency: ${URGENCY_LABELS[urgency]}. Yours to accept until ${closes}; after that it goes to other lawyers.\n\n${lawyerInboxLink()}`
      : `A client request matches you: ${practiceArea}, ${ukJurisdiction}. Urgency: ${URGENCY_LABELS[urgency]}. Open to accept until ${closes}.\n\n${lawyerInboxLink()}`;
    const emails = new Map((await LawyerProfileRepo.findEmails(lawyerIds)).map((u) => [u.id, u.email]));

    const results = await Promise.allSettled(
      lawyerIds.map(async (userId) => {
        emitToUser(userId, "client-request:new", event);
        // No organizationId: the inbox is the lawyer's own, so this shows in whichever workspace they're in.
        await NotificationSvc.create({
          userId,
          type: "CLIENT_REQUEST",
          title: askedForYou ? "A client asked for you" : "New client request",
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

  /** announce() for a KR request: KR lawyers, in Korean, with KR's area names and Korea's time, and
   * no part of the UK. Text-only email: the templates are English. */
  private static async announceKr(
    request: { id: string; brief: unknown; routingExpiresAt: Date | null; requestedOnly: boolean; case: { caseAreas: string[] } },
    lawyerIds: string[],
  ): Promise<number> {
    const urgency = (request.brief as { urgency?: RequestUrgency } | null)?.urgency ?? "ROUTINE";
    const caseAreas = (await CaseAreaSvc.refsOf(request.case.caseAreas, "KR")).map((a) => a.name);
    const event: ClientRequestNewEvent = {
      requestId: request.id,
      caseAreas,
      ukJurisdiction: null as unknown as UkJurisdiction,
      urgency,
      routingExpiresAt: request.routingExpiresAt!.toISOString(),
    };
    const practiceArea = areasLabel(caseAreas);
    const closes = formatKr(request.routingExpiresAt!);
    const askedForYou = request.requestedOnly;
    const link = lawyerInboxLink("KR");
    const subject = askedForYou ? `의뢰인이 변호사님을 지정했습니다: ${practiceArea}` : `새 의뢰 요청: ${practiceArea}`;
    const text = askedForYou
      ? `의뢰인이 변호사님께 의뢰를 요청했습니다: ${practiceArea}. 긴급도: ${URGENCY_LABELS_KO[urgency]}. ${closes}까지 수락할 수 있으며, 그 후에는 다른 변호사에게 전달됩니다.\n\n${link}`
      : `조건에 맞는 새 의뢰 요청이 있습니다: ${practiceArea}. 긴급도: ${URGENCY_LABELS_KO[urgency]}. ${closes}까지 수락할 수 있습니다.\n\n${link}`;
    const emails = new Map((await LawyerProfileRepo.findEmails(lawyerIds)).map((u) => [u.id, u.email]));
    const results = await Promise.allSettled(
      lawyerIds.map(async (userId) => {
        emitToUser(userId, "client-request:new", event);
        await NotificationSvc.create({
          userId,
          type: "CLIENT_REQUEST",
          title: askedForYou ? "의뢰인이 변호사님을 지정했습니다" : "새 의뢰 요청",
          message: `${practiceArea}. ${URGENCY_LABELS_KO[urgency]}.`,
          link: LAWYER_INBOX_PATH,
        }).catch((err) => logger.error("Client request: failed to create notification", { err, requestId: request.id, userId }));
        const to = emails.get(userId);
        if (to) await sendEmail({ to, subject, text });
      }),
    );
    logFailures(results, "Client request: announcement email failed", { requestId: request.id });
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

  /**
   * A request the client sent to one lawyer by name goes to every matching lawyer: the lawyer passed,
   * or their 24h ended with nobody on it. The client's app is told, and the matching lawyers are told
   * now rather than on the next sweep. False when it had already gone wider or a lawyer got on it first.
   */
  static async openToAll(requestId: string, clientId: string, now: Date = new Date()): Promise<boolean> {
    if (!(await ClientRequestRepo.openToAll(requestId, now))) return false;
    const updated: ClientRequestUpdatedEvent = { requestId, status: "ROUTED", updatedAt: now.toISOString() };
    emitToUser(clientId, "client-request:updated", updated);
    ClientRequestNotifySvc.announceInBackground(requestId);
    return true;
  }

  /** The sweep: requests sent to one lawyer by name whose 24h ended with nobody on them go to every
   * matching lawyer. How many went wider. */
  static async openDirectDue(now: Date): Promise<number> {
    let opened = 0;
    for (const request of await ClientRequestRepo.findDirectDue(now)) {
      try {
        if (await ClientRequestNotifySvc.openToAll(request.id, request.clientId, now)) opened++;
      } catch (err) {
        logger.error("Client request: opening a direct request to every lawyer failed", { requestId: request.id, err });
      }
    }
    return opened;
  }

  /**
   * The client deleted the case a request was on (ClientRequestSvc.withdrawBeforeCaseDeleted): the
   * request is gone, so a lawyer who has it open would otherwise be left on a page that no longer
   * loads. Every lawyer who was on it or was routed it gets a live event, and the ones who were on
   * it also get a bell notification, since they had put time into it. Best effort: the case is
   * already deleted, so a failure is logged, not thrown.
   */
  static async tellCaseDeleted({ requestId, heldBy, matching }: { requestId: string; heldBy: string[]; matching: string[] }): Promise<void> {
    const event: ClientRequestDeletedEvent = { requestId };
    for (const userId of [...heldBy, ...matching]) emitToUser(userId, "client-request:deleted", event);
    const results = await Promise.allSettled(
      heldBy.map((userId) =>
        NotificationSvc.create({
          userId,
          type: "CLIENT_REQUEST",
          title: "The client deleted this case",
          message: "The client deleted the case you were reviewing, so the request is no longer available. Nothing was charged to you.",
          link: LAWYER_INBOX_PATH,
        }),
      ),
    );
    logFailures(results, "Client request: failed to create case-deleted notification", { requestId });
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
          const korean = (request.client?.tenant?.code ?? "UK") === "KR";
          await NotificationSvc.create({
            userId: lawyerId,
            type: "CLIENT_REQUEST",
            title: korean ? "의뢰인이 견적을 선택하지 않았습니다" : "The client didn't choose a quote",
            message: korean
              ? "의뢰인이 기한 내에 변호사를 선택하지 않아 요청이 종료되었습니다. 변호사님께 청구된 금액은 없습니다."
              : "The client didn't pick a lawyer in time, so the request has closed. Nothing was charged to you.",
            link: `${LAWYER_INBOX_PATH}?view=history`,
          }).catch((err) => logger.error("Client request: failed to create notification", { err, requestId: request.id }));
        }
        await ClientRequestNotifySvc.tellClientExpired(request.client.email, request.caseId, unpicked, request.client?.tenant?.code ?? "UK").catch((err) =>
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
        const site = await siteOfUser(claim.lawyerId);
        const sent =
          site === "KR"
            ? sendEmail({
                to: claim.lawyer.email,
                subject: "의뢰 요청 보류 시간이 2시간 후 끝납니다",
                text: `의뢰 요청에 대한 24시간 보류가 ${formatKr(claim.expiresAt)}에 끝납니다. 그 전에 견적을 보내지 않으면 다른 변호사에게 돌아갑니다.\n\n${lawyerInboxLink("KR")}`,
              })
            : (async () => {
                const ends = formatUk(claim.expiresAt);
                const html = await renderTemplate("client-request-claim-expiring", { claimExpiresAt: ends, inboxLink: lawyerInboxLink() });
                const text = `Your 24-hour hold on a client request ends at ${ends}. Send a quote before then, or it goes back to other lawyers.\n\n${lawyerInboxLink()}`;
                return sendEmail({ to: claim.lawyer.email, subject: "Your hold on a client request ends in 2 hours", text, html });
              })();
        await sent.catch((err) =>
          logger.error("Client request: reminder email failed", { err, claimId: claim.id }),
        );
        reminded++;
      } catch (err) {
        logger.error("Client request: reminder failed", { claimId: claim.id, err });
      }
    }
    return reminded;
  }

  /**
   * Tells the client, in the bell and by email, that the refund an admin decided on a Lawyer Exit
   * (#972) went through: how much, and whether it's everything they paid. Only once it has succeeded
   * (at once, or on Stripe's webhook). Never the admin's note, nor why the lawyer left. Best effort:
   * a failure is logged.
   */
  static async tellClientRefunded(input: { requestId: string; caseId: string; clientId: string; refundedMinor: number; paidMinor: number | null; currency?: string }) {
    const site = await siteOfUser(input.clientId);
    if (site === "KR") return ClientRequestNotifySvc.tellClientRefundedKr(input);
    const gbp = (minor: number) => `£${(minor / 100).toFixed(2)}`;
    const amount = gbp(input.refundedMinor);
    const full = input.paidMinor !== null && input.refundedMinor >= input.paidMinor;
    const heading = `Your refund of ${amount} has been sent`;
    const message = full
      ? `We've reviewed what happened when your lawyer stopped acting on your case, and refunded your whole payment of ${amount}, ilovelawyer's fee included.`
      : input.paidMinor !== null
        ? `We've reviewed what happened when your lawyer stopped acting on your case, and refunded ${amount} of the ${gbp(input.paidMinor)} you paid.`
        : `We've reviewed what happened when your lawyer stopped acting on your case, and refunded ${amount}.`;
    const timing = "It's gone back to the card you paid with. It can take 5 to 10 working days to show on your statement.";
    const caseLink = clientCaseLink(input.caseId);

    await NotificationSvc.create({
      userId: input.clientId,
      type: "CLIENT_REQUEST",
      title: "Your refund is on its way",
      message: `We've refunded ${amount} to the card you paid with. It can take 5 to 10 working days to show on your statement.`,
      link: `/cases/${input.caseId}`,
    }).catch((err) => logger.error("Lawyer exit: failed to create refund notification", { err, requestId: input.requestId }));

    try {
      const client = await prisma.user.findUnique({ where: { id: input.clientId }, select: { email: true } });
      if (!client?.email) return;
      const html = await renderTemplate("client-refund-succeeded", { heading, message, timing, caseLink });
      await sendEmail({ to: client.email, subject: heading, text: [message, timing, caseLink].join("\n\n"), html });
    } catch (err) {
      logger.error("Lawyer exit: refund email failed", { err, requestId: input.requestId });
    }
  }

  private static async tellClientRefundedKr(input: { requestId: string; caseId: string; clientId: string; refundedMinor: number; paidMinor: number | null; currency?: string }) {
    const currency = input.currency ?? "KRW";
    const amount = moneyText(input.refundedMinor, currency);
    const full = input.paidMinor !== null && input.refundedMinor >= input.paidMinor;
    const heading = `${amount} 환불이 처리되었습니다`;
    const message = full
      ? `변호사가 사건 대리를 중단한 경위를 검토한 후, ilovelawyer 수수료를 포함해 결제하신 금액 ${amount} 전액을 환불했습니다.`
      : input.paidMinor !== null
        ? `변호사가 사건 대리를 중단한 경위를 검토한 후, 결제하신 ${moneyText(input.paidMinor, currency)} 중 ${amount}을(를) 환불했습니다.`
        : `변호사가 사건 대리를 중단한 경위를 검토한 후, ${amount}을(를) 환불했습니다.`;
    const timing = "결제하신 카드로 환불되었으며, 명세서에 표시되기까지 영업일 기준 5~10일이 걸릴 수 있습니다.";
    await NotificationSvc.create({ userId: input.clientId, type: "CLIENT_REQUEST", title: "환불이 진행 중입니다", message: `${amount}을(를) 결제하신 카드로 환불했습니다. ${timing}`, link: `/cases/${input.caseId}` }).catch(
      (err) => logger.error("Lawyer exit: failed to create refund notification", { err, requestId: input.requestId }),
    );
    try {
      const client = await prisma.user.findUnique({ where: { id: input.clientId }, select: { email: true } });
      if (client?.email) await sendEmail({ to: client.email, subject: heading, text: [message, timing, clientCaseLink(input.caseId, "KR")].join("\n\n") });
    } catch (err) {
      logger.error("Lawyer exit: refund email failed", { err, requestId: input.requestId });
    }
  }

  /**
   * Tells the client their lawyer closed the engagement (#972), in the bell and by email: that the
   * work is finished, or (`exit`) that the lawyer can't continue, and what happens to their money.
   * Never why the lawyer left: that stays with ilovelawyer. Best effort: a failure is logged.
   */
  static async tellClientClosed(input: {
    requestId: string;
    caseId: string;
    clientId: string;
    lawyerName: string;
    exit: { status: "REFUNDING" | "AWAITING_REVIEW" | "WAITING_ON_DISPUTE" | "NEEDS_ATTENTION" | "SETTLED"; paid: boolean } | null;
  }) {
    if ((await siteOfUser(input.clientId)) === "KR") return ClientRequestNotifySvc.tellClientClosedKr(input);
    const lawyer = input.lawyerName || "Your lawyer";
    const heading = input.exit ? `${lawyer} can't continue with your case` : `${lawyer} has closed your engagement`;
    const message = input.exit
      ? `${lawyer} has stopped acting on your case, and no longer has access to it.`
      : `${lawyer} has finished the work and closed the engagement. They no longer have access to your case.`;
    const refund = !input.exit?.paid
      ? null
      : input.exit.status === "WAITING_ON_DISPUTE"
        ? "Your bank is looking at a dispute on this payment, so it decides what you get back."
        : "We're reviewing your refund, to decide how much of your payment comes back to you. We'll let you know.";
    const next = input.exit ? "You can ask for another lawyer from your case whenever you're ready." : "You can rate your lawyer from your case.";
    const caseLink = clientCaseLink(input.caseId);

    await NotificationSvc.create({
      userId: input.clientId,
      type: "CLIENT_REQUEST",
      title: heading,
      message: [message, refund].filter(Boolean).join(" "),
      link: `/cases/${input.caseId}`,
    }).catch((err) => logger.error("Client request: failed to create notification", { err, requestId: input.requestId }));

    try {
      const client = await prisma.user.findUnique({ where: { id: input.clientId }, select: { email: true } });
      if (!client?.email) return;
      const html = await renderTemplate("client-request-closed-client", { heading, message, refund, next, caseLink });
      const text = [message, refund, next, caseLink].filter(Boolean).join("\n\n");
      await sendEmail({ to: client.email, subject: heading, text, html });
    } catch (err) {
      logger.error("Client request: close email failed", { err, requestId: input.requestId });
    }
  }

  private static async tellClientClosedKr(input: {
    requestId: string;
    caseId: string;
    clientId: string;
    lawyerName: string;
    exit: { status: "REFUNDING" | "AWAITING_REVIEW" | "WAITING_ON_DISPUTE" | "NEEDS_ATTENTION" | "SETTLED"; paid: boolean } | null;
  }) {
    const lawyer = input.lawyerName ? `${input.lawyerName} 변호사` : "담당 변호사";
    const heading = input.exit ? `${lawyer}가 사건을 계속 맡을 수 없게 되었습니다` : `${lawyer}가 의뢰를 종료했습니다`;
    const message = input.exit
      ? `${lawyer}가 사건 대리를 중단했으며, 더 이상 사건에 접근할 수 없습니다.`
      : `${lawyer}가 업무를 마치고 의뢰를 종료했습니다. 더 이상 사건에 접근할 수 없습니다.`;
    const refund = !input.exit?.paid
      ? null
      : input.exit.status === "WAITING_ON_DISPUTE"
        ? "이 결제에 대해 카드사가 이의 제기를 검토 중이며, 환불 금액은 카드사가 결정합니다."
        : "결제 금액 중 얼마를 환불할지 검토 중입니다. 결과가 나오면 알려 드리겠습니다.";
    const next = input.exit ? "준비되시면 사건 화면에서 다른 변호사를 요청할 수 있습니다." : "사건 화면에서 변호사를 평가할 수 있습니다.";
    await NotificationSvc.create({ userId: input.clientId, type: "CLIENT_REQUEST", title: heading, message: [message, refund].filter(Boolean).join(" "), link: `/cases/${input.caseId}` }).catch(
      (err) => logger.error("Client request: failed to create notification", { err, requestId: input.requestId }),
    );
    try {
      const client = await prisma.user.findUnique({ where: { id: input.clientId }, select: { email: true } });
      if (client?.email) await sendEmail({ to: client.email, subject: heading, text: [message, refund, next, clientCaseLink(input.caseId, "KR")].filter(Boolean).join("\n\n") });
    } catch (err) {
      logger.error("Client request: close email failed", { err, requestId: input.requestId });
    }
  }

  /** `unpicked`: lawyers quoted, but the client didn't pick one in time (several lawyers, phase 5).
   * A KR client hears in Korean, with a link to the KR site. */
  private static async tellClientExpired(email: string, caseId: string, unpicked: boolean, site: string = "UK") {
    if (site === "KR") {
      const heading = unpicked ? "변호사 요청이 종료되었습니다" : "이번에는 변호사를 찾지 못했습니다";
      const reason = unpicked ? "7일 이내에 견적을 선택하지 않아 요청이 종료되었습니다." : "48시간 이내에 요청을 수락한 변호사가 없어 요청이 종료되었습니다.";
      await sendEmail({ to: email, subject: heading, text: `${reason} 사건 화면에서 다시 변호사를 요청할 수 있습니다.\n\n${clientCaseLink(caseId, "KR")}` });
      return;
    }
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
