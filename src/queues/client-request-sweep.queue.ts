import cron, { type ScheduledTask } from "node-cron";
import ClientRequestClaimRepo from "../repositories/client-request-claim.repository";
import ClientRequestRepo from "../repositories/client-request.repository";
import OrganizationRepo from "../repositories/organization.repository";
import NotificationSvc from "../services/notification.service";
import ClientRequestNotifySvc from "../services/client-request-notify.service";
import SecurityAuditSvc from "../services/security-audit.service";
import { emitToUser } from "../lib/socket";
import { withCronLock } from "../lib/cron-lock";
import logger from "../utils/logger";
import type { ClientRequestUpdatedEvent } from "../types/client-handoff";

/** Every minute: a 24h hold that runs a few minutes over is something the lawyer would notice. */
const SCHEDULE = "* * * * *";

type LapsedClaim = Awaited<ReturnType<typeof ClientRequestClaimRepo.findLapsed>>[number];
type UnpaidFee = Awaited<ReturnType<typeof ClientRequestClaimRepo.findUnpaid>>[number];

type SweepResult = { lapsed: number; unpaid: number; expired: number; reminded: number; announced: number };

/**
 * The client request timers (the UK client-to-lawyer hand-off), in order: a claim's 24h hold
 * lapsing back to the pool (#511), a confirmed request whose introduction fee still hasn't gone
 * through after 48h going back too (#933), then a routed request nobody claimed within 48h expiring, the
 * 2h-before reminder to a lawyer holding one, and announcing routed requests nobody has been told
 * about yet, including the ones a lapse just put back (#510, ClientRequestNotifySvc). Each step is
 * a guarded update, so a run that overlaps another or dies halfway never acts on the same request
 * twice, and one step failing doesn't stop the rest.
 */
export default class ClientRequestSweepQueue {
  private static task: ScheduledTask | null = null;
  private static ticking = false;

  static start(): void {
    if (this.task) return;
    this.task = cron.schedule(
      SCHEDULE,
      () => withCronLock("client-request-sweep", async () => void (await this.tick())).catch((err) => logger.error("Client request sweep: run failed", { err })),
      { name: "client-request-sweep", timezone: "UTC", noOverlap: true },
    );
    logger.info("Client request sweep: cron job scheduled", { schedule: SCHEDULE });
  }

  /** One sweep. Called by the cron schedule; exposed for tests. */
  static async tick(now: Date = new Date()): Promise<SweepResult> {
    const result: SweepResult = { lapsed: 0, unpaid: 0, expired: 0, reminded: 0, announced: 0 };
    if (this.ticking) return result;
    this.ticking = true;
    try {
      result.lapsed = await this.step("lapse", () => this.lapseDue(now));
      result.unpaid = await this.step("unpaid", () => this.lapseUnpaidDue(now));
      result.expired = await this.step("expire", () => ClientRequestNotifySvc.expireDue(now));
      result.reminded = await this.step("remind", () => ClientRequestNotifySvc.remindDue(now));
      result.announced = await this.step("announce", () => ClientRequestNotifySvc.announceDue(now));
    } finally {
      this.ticking = false;
    }
    if (Object.values(result).some(Boolean)) logger.info("Client request sweep: run finished", result);
    return result;
  }

  /** One step of the run: a failure is logged and counts as nothing done, so later steps still run. */
  private static async step(name: string, run: () => Promise<number>): Promise<number> {
    try {
      return await run();
    } catch (err) {
      logger.error("Client request sweep: step failed", { step: name, err });
      return 0;
    }
  }

  private static async lapseDue(now: Date): Promise<number> {
    let lapsed = 0;
    for (const claim of await ClientRequestClaimRepo.findLapsed(now)) {
      try {
        if (await this.lapse(claim, now)) lapsed++;
      } catch (err) {
        logger.error("Client request sweep: lapse failed", { err, claimId: claim.id, requestId: claim.requestId });
      }
    }
    return lapsed;
  }

  private static async lapseUnpaidDue(now: Date): Promise<number> {
    let released = 0;
    for (const unpaid of await ClientRequestClaimRepo.findUnpaid(now)) {
      try {
        if (await this.lapseUnpaid(unpaid, now)) released++;
      } catch (err) {
        logger.error("Client request sweep: unpaid fee release failed", { err, requestId: unpaid.requestId, chargeId: unpaid.chargeId });
      }
    }
    return released;
  }

  /**
   * The client confirmed, but the lawyer's introduction fee still hasn't gone through after 48h
   * (#933): the request goes back to other lawyers so the client isn't left waiting, and the lawyer
   * is told. Recorded as the hold lapsing, with the reason.
   */
  private static async lapseUnpaid(unpaid: UnpaidFee, now: Date): Promise<boolean> {
    if (!(await ClientRequestClaimRepo.lapseUnpaid(unpaid, now))) return false;
    const { caseId, clientId, requestId, claim } = unpaid;
    const payload = { requestId, claimId: claim.id, chargeId: unpaid.chargeId, reason: "fee_unpaid" };

    await OrganizationRepo.writeAudit({ caseId, action: "client_request.claim_lapsed", payload: { ...payload, lawyerId: claim.lawyerId } });
    await SecurityAuditSvc.record({
      action: "client_request.claim_lapsed",
      actorId: null,
      organizationId: claim.organizationId,
      targetType: "user",
      targetId: claim.lawyerId,
      caseId,
      payload,
    });

    const updated: ClientRequestUpdatedEvent = { requestId, status: "ROUTED", updatedAt: now.toISOString() };
    emitToUser(claim.lawyerId, "client-request:updated", updated);
    emitToUser(clientId, "client-request:updated", { ...updated, status: (await ClientRequestRepo.shownStatus(requestId)) ?? "ROUTED" });
    await NotificationSvc.create({
      userId: claim.lawyerId,
      type: "CLIENT_REQUEST",
      title: "A client request went back to other lawyers",
      message: "The client confirmed you, but the introduction fee couldn't be charged for 48 hours, so the request went back to other lawyers.",
      link: "/homepage/client-requests",
    }).catch((err) => logger.error("Client request sweep: failed to create notification", { err, requestId }));
    return true;
  }

  /** The hold ran out: the request goes back to the pool without this lawyer, who's told. */
  private static async lapse(claim: LapsedClaim, now: Date): Promise<boolean> {
    if (!(await ClientRequestClaimRepo.lapse(claim, now))) return false;
    const { caseId, clientId } = claim.request;

    await OrganizationRepo.writeAudit({ caseId, action: "client_request.claim_lapsed", payload: { requestId: claim.requestId, claimId: claim.id, lawyerId: claim.lawyerId } });
    await SecurityAuditSvc.record({
      action: "client_request.claim_lapsed",
      actorId: null,
      organizationId: claim.organizationId,
      targetType: "user",
      targetId: claim.lawyerId,
      caseId,
      payload: { requestId: claim.requestId, claimId: claim.id },
    });

    const updated: ClientRequestUpdatedEvent = { requestId: claim.requestId, status: "ROUTED", updatedAt: now.toISOString() };
    emitToUser(claim.lawyerId, "client-request:updated", updated);
    // Several lawyers: others may still be on it, one with a quote, so the client hears what they'd see.
    emitToUser(clientId, "client-request:updated", { ...updated, status: (await ClientRequestRepo.shownStatus(claim.requestId)) ?? "ROUTED" });
    // No organizationId: the inbox is the lawyer's own, so this shows in whichever workspace they're in.
    await NotificationSvc.create({
      userId: claim.lawyerId,
      type: "CLIENT_REQUEST",
      title: "Your hold on a client request ended",
      message: "The 24 hours ran out before a quote was sent, so the request went back to other lawyers.",
      // ilovelawyer-app's Client Requests page; it opens on the inbox (no tab in the URL yet).
      link: "/homepage/client-requests",
    }).catch((err) => logger.error("Client request sweep: failed to create notification", { err, claimId: claim.id }));
    return true;
  }
}
