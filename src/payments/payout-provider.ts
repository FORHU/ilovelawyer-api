import Stripe from "stripe";
import { PAYOUT_PROVIDER } from "../config";
import { stripeClient } from "./stripe-client";

/**
 * Pays lawyers out of their wallet (WalletSvc). Two providers, chosen by PAYOUT_PROVIDER:
 *
 *  - DUMMY ("immediate"): the payout account is ready at once and a withdrawal is PAID on the spot.
 *    No money moves. The default, for local and dev.
 *  - STRIPE ("connect"): each wallet owner gets a Stripe Connect Express account, set up on Stripe's
 *    own onboarding pages (bank details never reach this API). A withdrawal is a transfer from the
 *    platform's balance to that account, then a payout from it to the bank (payouts are manual, so
 *    money only leaves when the lawyer asks). The payout ends on payout.paid / payout.failed, sent to
 *    the Connect webhook (POST /api/webhooks/stripe-connect).
 *
 * A wallet keeps the provider its account was made with (Wallet.provider), so a dummy account is never
 * paid out through Stripe.
 */
export interface PayoutAccountRequest {
  walletId: string;
  ownerType: "ORGANIZATION" | "USER";
  ownerId: string;
  email: string | null;
  name: string | null;
}

export interface PayoutAccountStatus {
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}

export interface PayoutRequest {
  /** Our Withdrawal id: the idempotency key for both the transfer and the payout. */
  withdrawalId: string;
  walletId: string;
  accountId: string;
  amountMinor: number;
  currency: string;
}

export interface PayoutResult {
  /** PROCESSING: Stripe has the payout; its webhook ends it. */
  status: "PAID" | "PROCESSING" | "FAILED";
  transferId: string | null;
  payoutId: string | null;
  failureReason: string | null;
}

export interface ImmediatePayoutProvider {
  readonly name: "DUMMY";
  readonly mode: "immediate";
  createAccount(request: PayoutAccountRequest): Promise<{ accountId: string } & PayoutAccountStatus>;
  payout(request: PayoutRequest): Promise<PayoutResult>;
}

export interface ConnectPayoutProvider {
  readonly name: "STRIPE";
  readonly mode: "connect";
  createAccount(request: PayoutAccountRequest): Promise<{ accountId: string } & PayoutAccountStatus>;
  /** Stripe's onboarding page for the account, valid for a few minutes. */
  onboardingLink(accountId: string, returnUrl: string, refreshUrl: string): Promise<string>;
  accountStatus(accountId: string): Promise<PayoutAccountStatus>;
  payout(request: PayoutRequest): Promise<PayoutResult>;
  /** Takes a transfer back to the platform after its payout failed. */
  reverseTransfer(transferId: string, amountMinor: number, withdrawalId: string): Promise<void>;
}

export type PayoutProvider = ImmediatePayoutProvider | ConnectPayoutProvider;

export const dummyPayoutProvider: ImmediatePayoutProvider = {
  name: "DUMMY",
  mode: "immediate",
  async createAccount(request) {
    return { accountId: `dummy_acct_${request.walletId}`, payoutsEnabled: true, detailsSubmitted: true };
  },
  async payout(request) {
    return { status: "PAID", transferId: `dummy_tr_${request.withdrawalId}`, payoutId: `dummy_po_${request.withdrawalId}`, failureReason: null };
  },
};

function statusOf(account: Pick<Stripe.Account, "payouts_enabled" | "details_submitted">): PayoutAccountStatus {
  return { payoutsEnabled: !!account.payouts_enabled, detailsSubmitted: !!account.details_submitted };
}

export const stripePayoutProvider: ConnectPayoutProvider = {
  name: "STRIPE",
  mode: "connect",
  async createAccount(request) {
    const account = await stripeClient().accounts.create(
      {
        type: "express",
        country: "GB",
        ...(request.email ? { email: request.email } : {}),
        ...(request.name ? { business_profile: { name: request.name } } : {}),
        capabilities: { transfers: { requested: true } },
        settings: { payouts: { schedule: { interval: "manual" } } },
        metadata: { walletId: request.walletId, ownerType: request.ownerType, ownerId: request.ownerId },
      },
      // Two admins starting onboarding at once get the same account.
      { idempotencyKey: `wallet-account-${request.walletId}` },
    );
    return { accountId: account.id, ...statusOf(account) };
  },
  async onboardingLink(accountId, returnUrl, refreshUrl) {
    const link = await stripeClient().accountLinks.create({ account: accountId, type: "account_onboarding", return_url: returnUrl, refresh_url: refreshUrl });
    return link.url;
  },
  async accountStatus(accountId) {
    return statusOf(await stripeClient().accounts.retrieve(accountId));
  },
  async payout(request) {
    const stripe = stripeClient();
    const metadata = { withdrawalId: request.withdrawalId, walletId: request.walletId };
    let transfer: Stripe.Transfer;
    try {
      transfer = await stripe.transfers.create(
        { amount: request.amountMinor, currency: request.currency.toLowerCase(), destination: request.accountId, metadata },
        { idempotencyKey: `withdrawal-transfer-${request.withdrawalId}` },
      );
    } catch (err) {
      if (err instanceof Stripe.errors.StripeInvalidRequestError) return { status: "FAILED", transferId: null, payoutId: null, failureReason: err.message };
      throw err;
    }
    try {
      const payout = await stripe.payouts.create(
        { amount: request.amountMinor, currency: request.currency.toLowerCase(), metadata },
        { stripeAccount: request.accountId, idempotencyKey: `withdrawal-payout-${request.withdrawalId}` },
      );
      if (payout.status === "paid") return { status: "PAID", transferId: transfer.id, payoutId: payout.id, failureReason: null };
      if (payout.status === "failed" || payout.status === "canceled") {
        return { status: "FAILED", transferId: transfer.id, payoutId: payout.id, failureReason: payout.failure_message ?? "The bank refused the payout." };
      }
      return { status: "PROCESSING", transferId: transfer.id, payoutId: payout.id, failureReason: null };
    } catch (err) {
      if (err instanceof Stripe.errors.StripeInvalidRequestError) return { status: "FAILED", transferId: transfer.id, payoutId: null, failureReason: err.message };
      throw err;
    }
  },
  async reverseTransfer(transferId, amountMinor, withdrawalId) {
    await stripeClient().transfers.createReversal(transferId, { amount: amountMinor }, { idempotencyKey: `withdrawal-reversal-${withdrawalId}` });
  },
};

let override: PayoutProvider | null = null;

export function payoutProvider(): PayoutProvider {
  if (override) return override;
  return PAYOUT_PROVIDER === "stripe" ? stripePayoutProvider : dummyPayoutProvider;
}

/** The provider a wallet's account was made with (Wallet.provider). */
export function payoutProviderNamed(name: string): PayoutProvider {
  if (override && override.name === name) return override;
  return name === "STRIPE" ? stripePayoutProvider : dummyPayoutProvider;
}

/** Tests only; null goes back to the configured provider. */
export function setPayoutProvider(next: PayoutProvider | null): void {
  override = next;
}
