import type { LawyerExit, LawyerExitStatus, QuotationPayment, ReleaseReason } from "@prisma/client";
import LawyerExitRepo, { DECIDABLE_LAWYER_EXIT_STATUSES, OPEN_LAWYER_EXIT_STATUSES } from "../repositories/lawyer-exit.repository";
import QuotationPaymentRepo from "../repositories/quotation-payment.repository";
import WalletRepo from "../repositories/wallet.repository";
import QuotationRefundSvc from "./quotation-refund.service";
import PayoutSettingsSvc from "./payout-settings.service";
import ClientPricingSvc from "./client-pricing.service";
import NotificationSvc from "./notification.service";
import SecurityAuditSvc from "./security-audit.service";
import WalletSvc from "./wallet.service";
import prisma from "../lib/prisma";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";

const DAY_MS = 24 * 60 * 60 * 1000;
const gbp = (minor: number) => `£${(minor / 100).toFixed(2)}`;
const money = (amountMinor: number, currency: string) => ({ amountMinor, currency });

/** How a reason reads in a refund's reason (which is audited): the category only, never the note. */
const REASON_LABELS: Record<ReleaseReason, string> = {
  CONFLICT: "a conflict",
  CAPACITY: "no capacity",
  OUT_OF_SCOPE: "out of scope",
  OTHER: "another reason",
};

/** Where a new exit starts. Nothing paid through ilovelawyer (a free first consultation, or a request
 * accepted before quotation payments): nothing to refund, so it's settled at once. A disputed
 * payment: the bank decides first. Otherwise an admin decides the refund, from the lawyer's reason
 * and any work they claim: nothing is ever refunded automatically. */
export function initialLawyerExitStatus(payment: Pick<QuotationPayment, "status"> | null): LawyerExitStatus {
  if (!payment) return "SETTLED";
  if (payment.status === "DISPUTED") return "WAITING_ON_DISPUTE";
  return "AWAITING_REVIEW";
}

async function notify(userId: string, n: { title: string; message: string; link: string }) {
  await NotificationSvc.create({ userId, type: "CLIENT_REQUEST", ...n }).catch((err) => logger.error("Lawyer exit: failed to create notification", { err, userId }));
}

/**
 * A Lawyer Exit (LawyerExit): the lawyer ending a paid engagement because they can't continue. Nothing
 * is refunded automatically: an admin reads the lawyer's reason (and any work they claim) and decides
 * how much goes back. Everything, the platform fee included, when the lawyer did nothing or the reason
 * wasn't good enough; part of the lawyer's share for work they did (the platform fee is kept); or
 * nothing. A disputed payment isn't refunded: the bank decides, and the exit carries on once it has.
 * Until the exit is SETTLED the lawyer's earning isn't released; then what's left of it starts the
 * tenant's hold, from the close. A refund that fails lands in NEEDS_ATTENTION for an admin, never
 * silently.
 */
export default class LawyerExitSvc {
  /** After the close: an exit with nothing paid is settled already, so its hold starts. Any other
   * waits on an admin (or the bank). */
  static async start(exit: LawyerExit) {
    if (exit.status === "SETTLED") await LawyerExitSvc.afterSettled(exit);
  }

  /** What a refund sent for this exit came back with. SUCCEEDED: settled. PENDING: waits for the
   * provider's webhook (afterRefund). FAILED, or not made at all: an admin has to act. */
  private static async afterIssued(exit: LawyerExit, issued: Awaited<ReturnType<typeof QuotationRefundSvc.issue>>, from: LawyerExitStatus[]) {
    if (!issued) {
      await LawyerExitRepo.move(exit.id, from, { status: "NEEDS_ATTENTION", refundId: null, failureReason: "The refund couldn't be made: another refund changed what's left of the payment." });
      logger.error("Lawyer exit: refund not made, needs an admin", { exitId: exit.id });
      return;
    }
    if (issued.status === "SUCCEEDED") return LawyerExitSvc.settle(exit, from, issued.refund.amountMinor);
    if (issued.status === "FAILED") {
      await LawyerExitRepo.move(exit.id, from, { status: "NEEDS_ATTENTION", refundId: null, failureReason: issued.failureReason ?? "The refund failed." });
      logger.error("Lawyer exit: refund failed, needs an admin", { exitId: exit.id, refundId: issued.refund.id });
      return;
    }
    // PENDING: keep which refund it's waiting on. Its webhook may already have come before this was
    // stored, so look at the refund again once it is.
    if (await LawyerExitRepo.move(exit.id, from, { status: "REFUNDING", refundId: issued.refund.id, failureReason: null })) {
      await LawyerExitSvc.afterRefund(issued.refund.id);
    }
  }

  /** A refund ended at the provider (refund.updated): settles the exit waiting on it, or hands it to
   * an admin when it failed. Nothing for a refund no exit is waiting on, or one still on its way. */
  static async afterRefund(refundId: string) {
    const exit = await LawyerExitRepo.findByRefund(refundId);
    if (!exit) return;
    const refund = await QuotationPaymentRepo.findRefund(refundId);
    if (!refund || refund.status === "PENDING") return;
    if (refund.status === "SUCCEEDED") return LawyerExitSvc.settle(exit, ["REFUNDING"], refund.amountMinor);
    if (await LawyerExitRepo.move(exit.id, ["REFUNDING"], { status: "NEEDS_ATTENTION", refundId: null, failureReason: refund.failureReason ?? "The refund failed." })) {
      logger.error("Lawyer exit: refund failed, needs an admin", { exitId: exit.id, refundId });
    }
  }

  /** The client's bank opened a dispute: an exit waiting on an admin waits on the bank instead. One
   * whose refund is already on its way carries on: Stripe settles it. */
  static async disputeOpened(paymentId: string) {
    for (const exit of await LawyerExitRepo.findForPayment(paymentId, DECIDABLE_LAWYER_EXIT_STATUSES)) {
      await LawyerExitRepo.move(exit.id, DECIDABLE_LAWYER_EXIT_STATUSES, { status: "WAITING_ON_DISPUTE" });
    }
  }

  /** The dispute was decided. Lost: the bank gave the client everything back (and took the lawyer's
   * earning), so the exit is settled. Otherwise it goes to an admin, as if there'd been no dispute. */
  static async disputeClosed(paymentId: string, lost: boolean) {
    for (const exit of await LawyerExitRepo.findForPayment(paymentId, ["WAITING_ON_DISPUTE"])) {
      if (lost) await LawyerExitSvc.settle(exit, ["WAITING_ON_DISPUTE"], 0, { byBank: true });
      else await LawyerExitRepo.move(exit.id, ["WAITING_ON_DISPUTE"], { status: "AWAITING_REVIEW" });
    }
  }

  /**
   * An admin's decision on an exit waiting on them (every paid exit, or one whose refund failed): how
   * much the client gets back, from the lawyer's reason and any work claimed. 0 settles it with no refund. Less than all of it comes out of the
   * lawyer's share and the platform fee is kept; everything left gives the platform fee back too (the
   * reason wasn't good enough). Audited (admin.lawyer_exit.decided, and the refund itself). 409
   * LAWYER_EXIT_NOT_OPEN when it isn't waiting on an admin; 409 NOT_REFUNDABLE while disputed; 502
   * REFUND_FAILED when the provider refuses it (the exit is back in NEEDS_ATTENTION).
   */
  static async decide(id: string, input: { amount: { amountMinor: number; currency: string }; note?: string }, adminId: string) {
    const exit = await LawyerExitRepo.findById(id);
    if (!exit) throw new HttpError("Lawyer exit not found", 404);
    if (!DECIDABLE_LAWYER_EXIT_STATUSES.includes(exit.status)) {
      throw new HttpError("This exit isn't waiting on a decision.", 409, "LAWYER_EXIT_NOT_OPEN", { status: exit.status });
    }
    const payment = exit.paymentId ? await QuotationPaymentRepo.findById(exit.paymentId) : null;
    if (!payment) throw new HttpError("This exit has no payment to refund.", 409, "LAWYER_EXIT_NOT_OPEN", { status: exit.status });
    if (input.amount.currency !== payment.currency) throw new HttpError(`This payment is in ${payment.currency}.`, 400, "REFUND_CURRENCY_MISMATCH");
    const amountMinor = input.amount.amountMinor;
    if (amountMinor > 0) await QuotationRefundSvc.assertRefundable(payment, amountMinor);

    const decided = { decidedById: adminId, decidedAt: new Date(), decisionNote: input.note?.trim() || null };
    const audit = () =>
      SecurityAuditSvc.record({
        action: "admin.lawyer_exit.decided",
        actorId: adminId,
        organizationId: null,
        targetType: "lawyer_exit",
        targetId: exit.id,
        // The amount only: the decision note, like the lawyer's, may name the other party.
        payload: { requestId: exit.requestId, paymentId: payment.id, amountMinor },
      });

    if (amountMinor === 0) {
      if (!(await LawyerExitRepo.move(exit.id, DECIDABLE_LAWYER_EXIT_STATUSES, decided))) throw LawyerExitSvc.movedOn(exit.id);
      await audit();
      await LawyerExitSvc.settle(exit, DECIDABLE_LAWYER_EXIT_STATUSES, 0);
      await notify(exit.clientId, {
        title: "We've reviewed your refund",
        message: exit.workDone
          ? "We looked at the work your lawyer did before they stopped acting. No refund is due."
          : "We looked at why your lawyer stopped acting. No refund is due.",
        link: `/cases/${exit.caseId}`,
      });
      return LawyerExitSvc.getForAdmin(exit.id);
    }

    // Taken off the queue first, so two admins can't both send a refund for it.
    if (!(await LawyerExitRepo.move(exit.id, DECIDABLE_LAWYER_EXIT_STATUSES, { ...decided, status: "REFUNDING", failureReason: null }))) throw LawyerExitSvc.movedOn(exit.id);
    await audit();
    const issued = await QuotationRefundSvc.issue(payment, amountMinor, `The lawyer couldn't continue (${REASON_LABELS[exit.reason]}): refund decided by ilovelawyer.`, { adminId });
    await LawyerExitSvc.afterIssued({ ...exit, status: "REFUNDING" }, issued, ["REFUNDING"]);
    if (issued?.status === "FAILED") throw new HttpError(issued.failureReason ?? "The refund failed.", 502, "REFUND_FAILED");
    if (!issued) throw new HttpError("Another refund changed what's left of this payment. Look again and retry.", 409, "REFUND_EXCEEDS_CHARGE");
    return LawyerExitSvc.getForAdmin(exit.id);
  }

  /** The admin queue: every exit still open by default (oldest first), or those in one status. */
  static async listForAdmin(query: { status?: LawyerExitStatus | "OPEN" | "ALL"; page: number; limit: number }) {
    const status = query.status ?? "OPEN";
    const where = status === "ALL" ? {} : status === "OPEN" ? { status: { in: OPEN_LAWYER_EXIT_STATUSES } } : { status };
    const { total, data } = await LawyerExitRepo.list(where, query.page, query.limit);
    return { total, page: query.page, pageSize: query.limit, data: await LawyerExitSvc.adminDtos(data) };
  }

  static async getForAdmin(id: string) {
    const exit = await LawyerExitRepo.findById(id);
    if (!exit) throw new HttpError("Lawyer exit not found", 404);
    return (await LawyerExitSvc.adminDtos([exit]))[0]!;
  }

  /** LawyerExitForAdmin: what the lawyer said (the notes included: admins only), the payment it's on
   * with what can still be refunded, and where it stands. */
  private static async adminDtos(exits: LawyerExit[]) {
    const paymentIds = exits.map((e) => e.paymentId).filter((id): id is string => !!id);
    const userIds = [...new Set(exits.flatMap((e) => [e.lawyerId, e.clientId]))];
    const orgIds = [...new Set(exits.map((e) => e.organizationId).filter((id): id is string => !!id))];
    const [payments, users, orgs, cases] = await Promise.all([
      paymentIds.length ? prisma.quotationPayment.findMany({ where: { id: { in: paymentIds } } }) : [],
      prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }),
      orgIds.length ? prisma.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } }) : [],
      prisma.case.findMany({ where: { id: { in: exits.map((e) => e.caseId) } }, select: { id: true, caseName: true } }),
    ]);
    const paymentById = new Map(payments.map((p) => [p.id, p]));
    const userById = new Map(users.map((u) => [u.id, u]));
    const orgById = new Map(orgs.map((o) => [o.id, o.name]));
    const caseById = new Map(cases.map((c) => [c.id, c.caseName]));
    return Promise.all(
      exits.map(async (e) => {
        const p = e.paymentId ? paymentById.get(e.paymentId) : undefined;
        const refundable = p && p.status !== "DISPUTED" && p.status !== "REFUNDED" ? await QuotationRefundSvc.refundable(p) : { left: 0, serviceLeft: 0 };
        const lawyer = userById.get(e.lawyerId);
        const client = userById.get(e.clientId);
        return {
          id: e.id,
          requestId: e.requestId,
          caseId: e.caseId,
          caseName: caseById.get(e.caseId) ?? null,
          status: e.status,
          lawyer: { id: e.lawyerId, name: lawyer?.name || lawyer?.email || null, firmName: e.organizationId ? (orgById.get(e.organizationId) ?? null) : null },
          client: { id: e.clientId, name: client?.name || client?.email || null },
          reason: e.reason,
          note: e.note,
          workDone: e.workDone,
          claimed: e.claimedMinor === null ? null : money(e.claimedMinor, e.currency),
          claimNote: e.claimNote,
          refunded: money(e.refundedMinor, e.currency),
          failureReason: e.failureReason,
          decision: e.decidedAt ? { decidedById: e.decidedById, decidedAt: e.decidedAt, note: e.decisionNote } : null,
          payment: p
            ? {
                id: p.id,
                status: p.status,
                amount: money(p.amountMinor, p.currency),
                serviceFee: money(p.serviceFeeMinor, p.currency),
                platformFee: money(p.platformFeeMinor, p.currency),
                refunded: money(p.refundedMinor, p.currency),
                refundable: money(Math.max(0, refundable.left), p.currency),
                refundableServiceFee: money(Math.max(0, Math.min(refundable.serviceLeft, refundable.left)), p.currency),
              }
            : null,
          createdAt: e.createdAt,
          settledAt: e.settledAt,
        };
      }),
    );
  }

  /** Ends the exit (from one of `from`) with `refundedMinor` more given back, then starts the
   * earning's hold and tells both sides. Once: a second call finds it moved on. */
  private static async settle(exit: LawyerExit, from: LawyerExitStatus[], refundedMinor: number, opts: { byBank?: boolean } = {}) {
    const now = new Date();
    if (!(await LawyerExitRepo.move(exit.id, from, { status: "SETTLED", settledAt: now, refundedMinor: { increment: refundedMinor }, refundId: null, failureReason: null }))) return;
    const settled = (await LawyerExitRepo.findById(exit.id))!;
    await LawyerExitSvc.afterSettled(settled, opts);
    if (refundedMinor > 0) {
      await notify(exit.clientId, {
        title: "Your refund is on its way",
        message: `We've refunded ${gbp(refundedMinor)} to the card you paid with. It can take 5 to 10 working days to show on your statement.`,
        link: `/cases/${exit.caseId}`,
      });
    }
  }

  /** A settled exit: what's left of the lawyer's earning starts the tenant's hold, counted from the
   * close, and the lawyer is told where it ended. */
  private static async afterSettled(exit: LawyerExit, opts: { byBank?: boolean } = {}) {
    const request = await prisma.clientRequest.findUnique({ where: { id: exit.requestId }, select: { closedAt: true } });
    const from = request?.closedAt ?? exit.createdAt;
    const terms = await PayoutSettingsSvc.forTenant(await ClientPricingSvc.tenantIdForClient(exit.clientId));
    const walletIds = await WalletRepo.startHold(exit.requestId, new Date(from.getTime() + terms.earningsHoldDays * DAY_MS));
    for (const walletId of walletIds) await WalletSvc.changedById(walletId);
    if (!exit.paymentId) return;
    await notify(exit.lawyerId, {
      title: "Your exit from an engagement is settled",
      message: opts.byBank
        ? "The client's bank decided the dispute in their favour and returned their payment, so your fee for it was taken back."
        : exit.refundedMinor > 0
          ? `The client was refunded ${gbp(exit.refundedMinor)}. Anything left of your fee is released after the usual hold.`
          : "Nothing was refunded to the client. Your fee is released after the usual hold.",
      link: `/client-requests/${exit.requestId}`,
    });
  }

  private static movedOn(id: string) {
    return new HttpError("Someone else acted on this exit first. Look again.", 409, "LAWYER_EXIT_NOT_OPEN", { id });
  }
}
