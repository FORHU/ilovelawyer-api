import SupportActionRepo from "../repositories/support-action.repository";
import ClientBillingSvc from "./client-billing.service";
import AuthSvc from "./auth.service";
import DeletionBlockSvc from "./deletion-block.service";
import { isKnownActionKey } from "../constants/support-actions.constants";
import { shownStatus } from "../utils/client-request-status";
import { isGoogleSsoAccount } from "../utils/auth.utils";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";

/** The actions POST /client/support/actions/:key runs. The rest are client-direct (the client calls
 * the endpoint that already does it): export and delete on /users/me, a ticket on /client/support/ticket. */
export const CLIENT_DISPATCHABLE_ACTIONS = ["CHECK_PAYMENT", "SHOW_CREDITS", "SHOW_LAWYER_REQUESTS", "SEND_PASSWORD_RESET"] as const;
export type ClientDispatchableAction = (typeof CLIENT_DISPATCHABLE_ACTIONS)[number];

/** The actions POST /support/actions/:key runs for someone who isn't signed in. */
export const VISITOR_ACTIONS = ["SEND_PASSWORD_RESET", "RESEND_CODE"] as const;
export type VisitorAction = (typeof VISITOR_ACTIONS)[number];

const PAYMENT_WINDOW_DAYS = 30;
const PAYMENT_LIMIT = 5;
const REQUEST_LIMIT = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

const money = (amountMinor: number, currency: string) => ({ amountMinor, currency });

/**
 * What the Support Chat's actions do for a client (EPIC ilovelawyer-client#120). The catalog is
 * fixed in code (SUPPORT_ACTIONS): a flow names an action by key, and admins can't change what it
 * does. Each result has a fixed shape the client renders without more calls. Deleting the account and
 * exporting data stay on their existing endpoints; the deletion block lives in DeletionBlockSvc.
 */
export default class SupportActionSvc {
  /** The key as a signed-in client may run it through the dispatcher, or the reason it can't. */
  static clientAction(key: string): ClientDispatchableAction {
    if (!isKnownActionKey(key)) throw new HttpError("That isn't a Support Action.", 404, "UNKNOWN_ACTION");
    if (!(CLIENT_DISPATCHABLE_ACTIONS as readonly string[]).includes(key)) {
      throw new HttpError("This action runs on its own endpoint, not here.", 400, "ACTION_NOT_DISPATCHABLE", { key });
    }
    return key as ClientDispatchableAction;
  }

  /** The key as a visitor may run it, or 404: the same answer for any other key, so the route reveals nothing else. */
  static visitorAction(key: string): VisitorAction {
    if (!(VISITOR_ACTIONS as readonly string[]).includes(key)) throw new HttpError("That isn't a Support Action.", 404, "UNKNOWN_ACTION");
    return key as VisitorAction;
  }

  static async run(key: ClientDispatchableAction, input: { userId: string; workspaceId: string; origin: string | null }) {
    switch (key) {
      case "CHECK_PAYMENT":
        return SupportActionSvc.checkPayment(input.userId);
      case "SHOW_CREDITS":
        return SupportActionSvc.showCredits(input.workspaceId);
      case "SHOW_LAWYER_REQUESTS":
        return SupportActionSvc.showLawyerRequests(input.userId);
      case "SEND_PASSWORD_RESET":
        return SupportActionSvc.sendPasswordReset(input.userId, input.origin);
    }
  }

  /** The client's last few payments. A PENDING Stripe one is checked with Stripe first and settled if it
   * has moved on (ClientBillingSvc.paymentStatus), so the result is where it really stands. */
  static async checkPayment(userId: string) {
    const since = new Date(Date.now() - PAYMENT_WINDOW_DAYS * DAY_MS);
    let rows = await SupportActionRepo.recentPayments(userId, since, PAYMENT_LIMIT);
    const pending = rows.filter((row) => row.status === "PENDING" && row.externalId);
    if (pending.length > 0) {
      await Promise.all(
        pending.map((row) =>
          ClientBillingSvc.paymentStatus(userId, row.id).catch((err) => logger.error("Support action: payment re-check failed", { err, paymentId: row.id })),
        ),
      );
      rows = await SupportActionRepo.recentPayments(userId, since, PAYMENT_LIMIT);
    }
    return {
      payments: rows.map((row) => ({
        paymentId: row.id,
        kind: row.kind,
        status: row.status,
        amount: money(row.amountMinor, row.currency),
        credits: row.credits,
        caseId: row.caseId,
        caseTitle: row.case?.caseName ?? null,
        createdAt: row.createdAt,
        failureReason: row.failureReason,
      })),
    };
  }

  /** Chat credits left on each active case. */
  static async showCredits(workspaceId: string) {
    const cases = await SupportActionRepo.creditsByCase(workspaceId);
    return { cases: cases.map((c) => ({ caseId: c.id, title: c.caseName, credits: c.clientCredits })) };
  }

  /** The client's latest lawyer requests, with the status as the app shows it and when it lapses. */
  static async showLawyerRequests(userId: string) {
    const rows = await SupportActionRepo.recentRequests(userId, REQUEST_LIMIT);
    return {
      requests: rows.map((row) => {
        const engaged = row.claims.find((c) => c.outcome === "ENGAGED");
        const lawyer = engaged ?? (row.claims.length === 1 ? row.claims[0] : undefined);
        return {
          id: row.id,
          caseId: row.caseId,
          caseTitle: row.case.caseName,
          status: shownStatus(row.status, row.claims),
          expiresAt: row.status === "ROUTED" ? (row.pickByAt ?? row.routingExpiresAt) : null,
          lawyerName: lawyer?.lawyer.name ?? null,
        };
      }),
    };
  }

  /** Emails the signed-in client a reset link at their own address. A Google account has no password:
   * AuthSvc.forgotPassword emails it a "sign in with Google" note instead, and this says so. */
  static async sendPasswordReset(userId: string, origin: string | null) {
    const account = await SupportActionRepo.emailOf(userId);
    if (!account) throw new HttpError("User not found", 404);
    await AuthSvc.forgotPassword(account.email, origin);
    return isGoogleSsoAccount(account) ? { sent: false as const, reason: "GOOGLE_ACCOUNT" as const } : { sent: true as const };
  }

  /** The step before the chat deletes the account: what blocks it, whether a password is needed (not for
   * a Google account), and the credits that would be lost. */
  static async deletionCheck(userId: string, workspaceId: string) {
    const [blocking, account, cases] = await Promise.all([
      DeletionBlockSvc.openLawyerRequests(userId),
      SupportActionRepo.emailOf(userId),
      SupportActionRepo.creditsByCase(workspaceId),
    ]);
    return {
      blocking,
      hasPassword: !!account?.password && !isGoogleSsoAccount(account),
      creditsRemaining: cases.reduce((sum, c) => sum + c.clientCredits, 0),
    };
  }

  /**
   * A visitor asks for a reset link or a new sign-in code. It answers the same whether or not the
   * email has an account, and doesn't wait for the work (the email is only sent when it does), so
   * neither the answer nor the time it takes says which. AuthSvc has its own cooldowns and
   * anti-enumeration; this only starts it.
   */
  static requestForVisitor(key: VisitorAction, email: string, origin: string | null): { ok: true } {
    const work = key === "SEND_PASSWORD_RESET" ? AuthSvc.forgotPassword(email, origin) : AuthSvc.sendOtp(email);
    void work.catch((err) => logger.error("Support action: visitor request failed", { err, key }));
    return { ok: true };
  }
}
