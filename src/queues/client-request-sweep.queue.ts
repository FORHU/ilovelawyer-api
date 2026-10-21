import cron, { type ScheduledTask } from "node-cron";
import ClientRequestClaimRepo from "../repositories/client-request-claim.repository";
import OrganizationRepo from "../repositories/organization.repository";
import NotificationSvc from "../services/notification.service";
import SecurityAuditSvc from "../services/security-audit.service";
import { emitToUser } from "../lib/socket";
import { withCronLock } from "../lib/cron-lock";
import logger from "../utils/logger";
import type { ClientRequestUpdatedEvent } from "../types/client-handoff";

/** Every minute: a 24h hold that runs a few minutes over is something the lawyer would notice. */
const SCHEDULE = "* * * * *";

type LapsedClaim = Awaited<ReturnType<typeof ClientRequestClaimRepo.findLapsed>>[number];

/**
 * The client request timers (the UK client-to-lawyer hand-off). #511: a claim's 24h hold lapsing
 * back to the pool. #510 adds the 48h routing expiry, the 2h claim reminder and announcing new
 * requests here. Each step is a guarded update, so a run that overlaps another or dies halfway
 * never acts on the same request twice.
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
  static async tick(now: Date = new Date()): Promise<{ lapsed: number }> {
    if (this.ticking) return { lapsed: 0 };
    this.ticking = true;
    let lapsed = 0;
    try {
      for (const claim of await ClientRequestClaimRepo.findLapsed(now)) {
        try {
          if (await this.lapse(claim, now)) lapsed++;
        } catch (err) {
          logger.error("Client request sweep: lapse failed", { err, claimId: claim.id, requestId: claim.requestId });
        }
      }
    } catch (err) {
      logger.error("Client request sweep: run failed", { err });
    } finally {
      this.ticking = false;
    }
    if (lapsed) logger.info("Client request sweep: run finished", { lapsed });
    return { lapsed };
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
    emitToUser(clientId, "client-request:updated", updated);
    // No organizationId: the inbox is the lawyer's own, so this shows in whichever workspace they're in.
    await NotificationSvc.create({
      userId: claim.lawyerId,
      type: "CLIENT_REQUEST",
      title: "Your hold on a client request ended",
      message: "The 24 hours ran out before a quote was sent, so the request went back to other lawyers.",
      link: "/client-requests?view=history",
    }).catch((err) => logger.error("Client request sweep: failed to create notification", { err, claimId: claim.id }));
    return true;
  }
}
