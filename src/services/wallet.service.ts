import type Stripe from "stripe";
import type { Earning, Wallet, WalletLedgerEntry, Withdrawal } from "@prisma/client";
import WalletRepo, { type Balances, type WalletOwner } from "../repositories/wallet.repository";
import prisma from "../lib/prisma";
import PayoutSettingsSvc from "./payout-settings.service";
import { allowedReturnUrl } from "./organization-card.service";
import SecurityAuditSvc from "./security-audit.service";
import NotificationSvc from "./notification.service";
import { payoutProvider, payoutProviderNamed } from "../payments/payout-provider";
import { emitToUser } from "../lib/socket";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";
import { CLIENT_HANDOFF_SOCKET_EVENTS, type WalletUpdatedEvent } from "../types/client-handoff";

const money = (amountMinor: number, currency: string) => ({ amountMinor, currency });

/** Who a claim's earnings are paid to. The one place that decides it (see the backlog in CONTEXT.md:
 * firm or lawyer as payee): for now the firm the lawyer claimed under, else the solo lawyer. A rule
 * that pays a firm's lawyers to their own wallets changes this function and nothing else; each
 * earning keeps the wallet it was paid into. */
export function payeeOf(claim: { organizationId: string | null; lawyerId: string }): WalletOwner {
  return claim.organizationId ? { ownerType: "ORGANIZATION", ownerId: claim.organizationId } : { ownerType: "USER", ownerId: claim.lawyerId };
}

/** Who may see and withdraw from a wallet: a firm's OWNERs and ADMINs, or the person whose own it
 * is. The routes check the same (requireOrgRole, /users/me); this is for anything that reaches a
 * wallet another way, and for who to tell when it changes. */
export async function walletManagers(owner: WalletOwner): Promise<string[]> {
  if (owner.ownerType === "USER") return [owner.ownerId];
  const rows = await prisma.organizationMember.findMany({
    where: { organizationId: owner.ownerId, status: "ACCEPTED", role: { in: ["OWNER", "ADMIN"] } },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

async function tenantIdOfOwner(owner: WalletOwner): Promise<string | null> {
  if (owner.ownerType === "ORGANIZATION") return (await prisma.organization.findUnique({ where: { id: owner.ownerId }, select: { tenantId: true } }))?.tenantId ?? null;
  return (await prisma.user.findUnique({ where: { id: owner.ownerId }, select: { tenantId: true } }))?.tenantId ?? null;
}

async function ownerName(owner: WalletOwner): Promise<{ name: string | null; email: string | null }> {
  if (owner.ownerType === "ORGANIZATION") return { name: (await prisma.organization.findUnique({ where: { id: owner.ownerId }, select: { name: true } }))?.name ?? null, email: null };
  const user = await prisma.user.findUnique({ where: { id: owner.ownerId }, select: { name: true, email: true } });
  return { name: user?.name ?? null, email: user?.email ?? null };
}

function balancesDto(b: Balances, currency: string) {
  return { pending: money(b.PENDING, currency), available: money(b.AVAILABLE, currency), reserved: money(b.RESERVED, currency), withdrawn: money(b.WITHDRAWN, currency) };
}

export function earningDto(e: Earning) {
  return {
    id: e.id,
    requestId: e.requestId,
    quotationId: e.quotationId,
    status: e.status,
    gross: money(e.grossMinor, e.currency),
    platformFee: money(e.platformFeeMinor, e.currency),
    net: money(e.netMinor, e.currency),
    reversed: money(e.reversedMinor, e.currency),
    disputed: e.disputed,
    availableAt: e.availableAt,
    releasedAt: e.releasedAt,
    createdAt: e.createdAt,
  };
}

export function withdrawalDto(w: Withdrawal) {
  return { id: w.id, status: w.status, amount: money(w.amountMinor, w.currency), failureReason: w.failureReason, paidAt: w.paidAt, createdAt: w.createdAt };
}

function entryDto(e: WalletLedgerEntry) {
  return { id: e.id, bucket: e.bucket, kind: e.kind, amount: money(e.amountMinor, e.currency), sourceId: e.sourceId, note: e.note, createdAt: e.createdAt };
}

/**
 * A payee's wallet (Wallet) and paying it out (Withdrawal): what the lawyer app's Earnings page shows
 * and does. Earnings come in from QuotationPaymentSvc and wait PENDING for the tenant's hold, then
 * the sweep releases them to AVAILABLE (releaseDue). A withdrawal reserves part of the available
 * balance, then the payout provider moves it to the owner's bank through Stripe Connect; the
 * reserve becomes WITHDRAWN on payout.paid, or goes back to AVAILABLE on payout.failed.
 */
export default class WalletSvc {
  /** Wallet in the contract: the balances, the payout account, and the tenant's terms. */
  static async get(owner: WalletOwner) {
    const wallet = await WalletRepo.findOrCreate(owner);
    return WalletSvc.dto(wallet);
  }

  static async ledger(owner: WalletOwner, page: number, limit: number) {
    const wallet = await WalletRepo.findOrCreate(owner);
    const { total, data } = await WalletRepo.listEntries(wallet.id, page, limit);
    return { total, data: data.map(entryDto) };
  }

  static async earnings(owner: WalletOwner, page: number, limit: number) {
    const wallet = await WalletRepo.findOrCreate(owner);
    const { total, data } = await WalletRepo.listEarnings(wallet.id, page, limit);
    return { total, data: data.map(earningDto) };
  }

  static async withdrawals(owner: WalletOwner, page: number, limit: number) {
    const wallet = await WalletRepo.findOrCreate(owner);
    const { total, data } = await WalletRepo.listWithdrawals(wallet.id, page, limit);
    return { total, data: data.map(withdrawalDto) };
  }

  /**
   * Starts (or carries on) setting up where the owner is paid: makes their payout account on first
   * use, then returns Stripe's onboarding page to send them to (null with the dummy, which is ready at
   * once). Audited, as changing where money goes.
   */
  static async startOnboarding(owner: WalletOwner, userId: string, returnUrl: string) {
    let wallet = await WalletRepo.findOrCreate(owner);
    const provider = wallet.provider ? payoutProviderNamed(wallet.provider) : payoutProvider();
    if (!wallet.stripeAccountId) {
      const { name, email } = await ownerName(owner);
      const account = await provider.createAccount({ walletId: wallet.id, ownerType: owner.ownerType, ownerId: owner.ownerId, email, name });
      wallet = await WalletRepo.setAccount(wallet.id, { provider: provider.name, stripeAccountId: account.accountId, payoutsEnabled: account.payoutsEnabled, detailsSubmitted: account.detailsSubmitted });
    }
    await SecurityAuditSvc.record({
      action: "wallet.payout_account_started",
      actorId: userId,
      organizationId: owner.ownerType === "ORGANIZATION" ? owner.ownerId : null,
      targetType: "wallet",
      targetId: wallet.id,
      payload: { provider: provider.name },
    });
    const back = allowedReturnUrl(returnUrl);
    const url = provider.mode === "connect" ? await provider.onboardingLink(wallet.stripeAccountId!, back, back) : null;
    return { url, wallet: await WalletSvc.dto(wallet) };
  }

  /** Reads the payout account's state from Stripe again (the app coming back from onboarding, before
   * account.updated arrives). */
  static async refreshAccount(owner: WalletOwner) {
    let wallet = await WalletRepo.findOrCreate(owner);
    if (wallet.stripeAccountId && wallet.provider) {
      const provider = payoutProviderNamed(wallet.provider);
      if (provider.mode === "connect") wallet = await WalletRepo.setAccountStatus(wallet.id, await provider.accountStatus(wallet.stripeAccountId));
    }
    return WalletSvc.dto(wallet);
  }

  /**
   * Withdraws `amountMinor` of the available balance to the owner's bank. At least the tenant's
   * minimum (400 WITHDRAWAL_BELOW_MINIMUM), at most what's available (409 INSUFFICIENT_BALANCE), and
   * only with a payout account Stripe has enabled (409 PAYOUT_ACCOUNT_REQUIRED). The same
   * `idempotencyKey` (the Idempotency-Key header) returns the same withdrawal, so a retried request
   * can't pay out twice. Audited.
   */
  static async withdraw(owner: WalletOwner, userId: string, amountMinor: number, idempotencyKey: string) {
    const wallet = await WalletRepo.findOrCreate(owner);
    if (!wallet.stripeAccountId || !wallet.provider || !wallet.payoutsEnabled) {
      throw new HttpError("Set up your payout account before withdrawing.", 409, "PAYOUT_ACCOUNT_REQUIRED");
    }
    const tenantId = await tenantIdOfOwner(owner);
    const terms = tenantId ? await PayoutSettingsSvc.forTenant(tenantId) : null;
    const minMinor = terms?.minWithdrawalMinor ?? 0;
    const reserved = await WalletRepo.reserveWithdrawal({
      walletId: wallet.id,
      requestedById: userId,
      amountMinor,
      currency: wallet.currency,
      provider: wallet.provider,
      idempotencyKey: `${wallet.id}:${idempotencyKey}`,
      minMinor,
    });
    if ("refused" in reserved) {
      if (reserved.refused === "BELOW_MINIMUM") {
        throw new HttpError(`The smallest withdrawal is £${(minMinor / 100).toFixed(2)}.`, 400, "WITHDRAWAL_BELOW_MINIMUM", { minimum: money(minMinor, wallet.currency) });
      }
      throw new HttpError("That's more than your available balance.", 409, "INSUFFICIENT_BALANCE", { available: money(reserved.available, wallet.currency) });
    }
    if (reserved.existing) return withdrawalDto(reserved.withdrawal);

    const withdrawal = reserved.withdrawal;
    await SecurityAuditSvc.record({
      action: "wallet.withdrawal_requested",
      actorId: userId,
      organizationId: owner.ownerType === "ORGANIZATION" ? owner.ownerId : null,
      targetType: "wallet",
      targetId: wallet.id,
      payload: { withdrawalId: withdrawal.id, amountMinor },
    });

    const provider = payoutProviderNamed(wallet.provider);
    try {
      const result = await provider.payout({ withdrawalId: withdrawal.id, walletId: wallet.id, accountId: wallet.stripeAccountId, amountMinor, currency: wallet.currency });
      if (result.status === "PROCESSING") {
        await WalletRepo.setWithdrawalIds(withdrawal.id, result);
      } else {
        if (result.status === "FAILED" && result.transferId && provider.mode === "connect") await provider.reverseTransfer(result.transferId, amountMinor, withdrawal.id);
        await WalletSvc.settleWithdrawal(withdrawal.id, result.status === "PAID" ? { paid: true } : { paid: false, reason: result.failureReason ?? "The payout failed." }, result);
      }
    } catch (err) {
      // No answer: the reserve stays until the provider's webhook says how it ended, or ops look.
      logger.error("Wallet: payout provider unreachable", { withdrawalId: withdrawal.id, err: err instanceof Error ? err.message : String(err) });
    }
    await WalletSvc.changed(wallet.id, owner);
    return withdrawalDto((await WalletRepo.findWithdrawal(withdrawal.id))!);
  }

  /** The sweep (ClientRequestSweepQueue): releases every earning whose hold is over to AVAILABLE, and
   * tells each wallet's managers. Returns how many were released. */
  static async releaseDue(now: Date = new Date()): Promise<number> {
    let released = 0;
    const wallets = new Set<string>();
    for (const earning of await WalletRepo.findReleasable(now)) {
      try {
        const done = await WalletRepo.release(earning, now);
        if (done) {
          released++;
          wallets.add(done.walletId);
        }
      } catch (err) {
        logger.error("Wallet: release failed", { earningId: earning.id, err });
      }
    }
    for (const walletId of wallets) await WalletSvc.changedById(walletId);
    return released;
  }

  /**
   * An event from a lawyer's connected account (POST /api/webhooks/stripe-connect): account.updated
   * keeps the payout account's state; payout.paid / payout.failed end the withdrawal it belongs to.
   */
  static async applyConnectEvent(event: Stripe.Event) {
    switch (event.type) {
      case "account.updated": {
        const account = event.data.object as Stripe.Account;
        const wallet = await WalletRepo.findByStripeAccount(account.id);
        if (!wallet) return;
        await WalletRepo.setAccountStatus(wallet.id, { payoutsEnabled: !!account.payouts_enabled, detailsSubmitted: !!account.details_submitted });
        await WalletSvc.changedById(wallet.id);
        return;
      }
      case "payout.paid":
      case "payout.failed": {
        const payout = event.data.object as Stripe.Payout;
        const withdrawal = (payout.metadata?.withdrawalId ? await WalletRepo.findWithdrawal(payout.metadata.withdrawalId) : null) ?? (await WalletRepo.findWithdrawalByPayout(payout.id));
        if (!withdrawal) {
          logger.info("Stripe Connect webhook: no withdrawal of ours", { payoutId: payout.id });
          return;
        }
        if (event.type === "payout.paid") {
          await WalletSvc.settleWithdrawal(withdrawal.id, { paid: true }, { payoutId: payout.id });
        } else {
          // The money is back on the connected account: take the transfer back to the platform, so the
          // wallet's AVAILABLE balance (which it returns to) is real.
          const wallet = await WalletRepo.findById(withdrawal.walletId);
          const provider = wallet?.provider ? payoutProviderNamed(wallet.provider) : null;
          if (withdrawal.transferId && provider?.mode === "connect") await provider.reverseTransfer(withdrawal.transferId, withdrawal.amountMinor, withdrawal.id);
          await WalletSvc.settleWithdrawal(withdrawal.id, { paid: false, reason: payout.failure_message ?? "The bank refused the payout." }, { payoutId: payout.id });
        }
        return;
      }
      default:
        return;
    }
  }

  /** Every wallet with its balances, for the admin app. */
  static async listForAdmin(page: number, limit: number) {
    const { total, data } = await WalletRepo.listAll(page, limit);
    const balances = await WalletRepo.balancesFor(data.map((w) => w.id));
    const orgIds = data.filter((w) => w.ownerType === "ORGANIZATION").map((w) => w.ownerId);
    const userIds = data.filter((w) => w.ownerType === "USER").map((w) => w.ownerId);
    const [orgs, users] = await Promise.all([
      orgIds.length ? prisma.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } }) : [],
      userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }) : [],
    ]);
    const names = new Map<string, string>([...orgs.map((o) => [o.id, o.name] as const), ...users.map((u) => [u.id, u.name || u.email] as const)]);
    return {
      total,
      data: data.map((w) => ({
        id: w.id,
        owner: { type: w.ownerType, id: w.ownerId, name: names.get(w.ownerId) ?? null },
        balances: balancesDto(balances.get(w.id)!, w.currency),
        payoutAccount: { provider: w.provider, connected: !!w.stripeAccountId, payoutsEnabled: w.payoutsEnabled },
        createdAt: w.createdAt,
      })),
    };
  }

  private static async settleWithdrawal(id: string, outcome: { paid: true } | { paid: false; reason: string }, ids: { transferId?: string | null; payoutId?: string | null }) {
    const ended = await WalletRepo.settleWithdrawal(id, outcome, ids);
    if (!ended) return;
    const wallet = await WalletRepo.findById(ended.walletId);
    if (!wallet) return;
    const owner = { ownerType: wallet.ownerType, ownerId: wallet.ownerId };
    await WalletSvc.changed(wallet.id, owner);
    if (!outcome.paid) {
      for (const userId of await walletManagers(owner)) {
        await NotificationSvc.create({
          userId,
          type: "CLIENT_REQUEST",
          title: "A withdrawal couldn't be paid",
          message: `${outcome.reason} The money is back in your available balance.`,
          // The lawyer app's Earnings section: on the firm's Organization page, or a solo lawyer's Profile.
          link: owner.ownerType === "ORGANIZATION" ? "/homepage/organization" : "/homepage/profile",
        }).catch((err) => logger.error("Wallet: failed to create notification", { err, withdrawalId: id }));
      }
    }
  }

  private static async dto(wallet: Wallet) {
    const owner = { ownerType: wallet.ownerType, ownerId: wallet.ownerId };
    const [balances, tenantId] = await Promise.all([WalletRepo.balances(wallet.id), tenantIdOfOwner(owner)]);
    const terms = tenantId ? await PayoutSettingsSvc.forTenant(tenantId) : null;
    return {
      id: wallet.id,
      owner: { type: wallet.ownerType, id: wallet.ownerId },
      currency: wallet.currency,
      balances: balancesDto(balances, wallet.currency),
      payoutAccount: {
        provider: wallet.provider,
        connected: !!wallet.stripeAccountId,
        detailsSubmitted: wallet.detailsSubmitted,
        payoutsEnabled: wallet.payoutsEnabled,
      },
      minWithdrawal: money(terms?.minWithdrawalMinor ?? 0, wallet.currency),
      earningsHoldDays: terms?.earningsHoldDays ?? null,
    };
  }

  /** Tells the wallet's managers to refetch it (wallet:updated). */
  static async changed(walletId: string, owner: WalletOwner) {
    const event: WalletUpdatedEvent = { walletId };
    for (const userId of await walletManagers(owner)) emitToUser(userId, CLIENT_HANDOFF_SOCKET_EVENTS.WALLET_UPDATED, event);
  }

  static async changedById(walletId: string) {
    const wallet = await WalletRepo.findById(walletId);
    if (wallet) await WalletSvc.changed(wallet.id, { ownerType: wallet.ownerType, ownerId: wallet.ownerId });
  }
}
