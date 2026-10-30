import { Prisma, type Earning, type Wallet, type WalletBucket, type WalletEntryKind, type WalletOwnerType, type Withdrawal } from "@prisma/client";
import prisma from "../lib/prisma";

type Tx = Prisma.TransactionClient;

/** Who a wallet belongs to: a firm, or a person (a solo lawyer). */
export interface WalletOwner {
  ownerType: WalletOwnerType;
  ownerId: string;
}

export type Balances = Record<WalletBucket, number>;

const EMPTY: Balances = { PENDING: 0, AVAILABLE: 0, RESERVED: 0, WITHDRAWN: 0 };

/** Rolls a transaction back when what it acts on had already moved on. */
class MovedOn extends Error {}

/** One move in the ledger: the same amount out of one bucket and into another, as two entries. */
async function move(tx: Tx, walletId: string, from: WalletBucket | null, to: WalletBucket | null, p: { kind: WalletEntryKind; amountMinor: number; currency: string; sourceId: string; key: string; note?: string }) {
  const rows: Prisma.WalletLedgerEntryCreateManyInput[] = [];
  if (from) rows.push({ walletId, bucket: from, kind: p.kind, amountMinor: -p.amountMinor, currency: p.currency, sourceId: p.sourceId, idempotencyKey: `${p.key}:from`, note: p.note });
  if (to) rows.push({ walletId, bucket: to, kind: p.kind, amountMinor: p.amountMinor, currency: p.currency, sourceId: p.sourceId, idempotencyKey: `${p.key}:to`, note: p.note });
  await tx.walletLedgerEntry.createMany({ data: rows });
}

async function balancesIn(tx: Tx | typeof prisma, walletId: string): Promise<Balances> {
  const sums = await tx.walletLedgerEntry.groupBy({ by: ["bucket"], where: { walletId }, _sum: { amountMinor: true } });
  return sums.reduce((acc, s) => ({ ...acc, [s.bucket]: s._sum.amountMinor ?? 0 }), { ...EMPTY });
}

/** Takes the wallet row's lock, so withdrawals and reversals on one wallet run one at a time. */
async function lockWallet(tx: Tx, walletId: string) {
  await tx.wallet.update({ where: { id: walletId }, data: { updatedAt: new Date() } });
}

/**
 * Writes `amountMinor` of an earning back out of the wallet (a refund, a lost dispute), inside the
 * caller's transaction: from PENDING while it's still held, else from AVAILABLE, which can go below
 * zero when the lawyer has already withdrawn it (later earnings pay it back). Never more than is left
 * of the earning. Returns what was reversed.
 */
export async function reverseEarningTx(tx: Tx, earningId: string, amountMinor: number, key: string, note: string): Promise<{ walletId: string; reversedMinor: number } | null> {
  const earning = await tx.earning.findUnique({ where: { id: earningId } });
  if (!earning || earning.status === "REVERSED") return null;
  const amount = Math.min(amountMinor, earning.netMinor - earning.reversedMinor);
  if (amount <= 0) return null;
  await lockWallet(tx, earning.walletId);
  const reversedMinor = earning.reversedMinor + amount;
  const updated = await tx.earning.updateMany({
    where: { id: earning.id, reversedMinor: earning.reversedMinor },
    data: { reversedMinor, ...(reversedMinor >= earning.netMinor ? { status: "REVERSED" } : {}) },
  });
  if (updated.count !== 1) return null;
  await move(tx, earning.walletId, earning.status === "AVAILABLE" ? "AVAILABLE" : "PENDING", null, {
    kind: "REVERSAL",
    amountMinor: amount,
    currency: earning.currency,
    sourceId: earning.id,
    key,
    note,
  });
  return { walletId: earning.walletId, reversedMinor: amount };
}

/** Creates the earning for a payment and puts it in the wallet's PENDING bucket, inside the caller's
 * transaction (QuotationPaymentRepo.settle). */
export async function createEarningTx(tx: Tx, data: Omit<Prisma.EarningUncheckedCreateInput, "id" | "status" | "reversedMinor">): Promise<Earning> {
  const earning = await tx.earning.create({ data });
  await move(tx, earning.walletId, null, "PENDING", { kind: "EARNING", amountMinor: earning.netMinor, currency: earning.currency, sourceId: earning.id, key: `earning:${earning.id}` });
  return earning;
}

/**
 * A payee's wallet (Wallet) and its append-only ledger (WalletLedgerEntry): every balance is the sum
 * of one bucket's entries. Each move between buckets is a pair of entries with unique idempotency
 * keys, written in the same transaction as the state change it records (an earning released, a
 * withdrawal reserved, paid or failed), and that state change is itself a guarded update, so a
 * replayed webhook or an overlapping sweep can't move anything twice.
 */
export default class WalletRepo {
  /** The owner's wallet, made on first use. */
  static async findOrCreate(owner: WalletOwner, currency = "GBP"): Promise<Wallet> {
    return prisma.wallet.upsert({
      where: { ownerType_ownerId: { ownerType: owner.ownerType, ownerId: owner.ownerId } },
      create: { ownerType: owner.ownerType, ownerId: owner.ownerId, currency },
      update: {},
    });
  }

  static async findByOwner(owner: WalletOwner) {
    return prisma.wallet.findUnique({ where: { ownerType_ownerId: { ownerType: owner.ownerType, ownerId: owner.ownerId } } });
  }

  static async findById(id: string) {
    return prisma.wallet.findUnique({ where: { id } });
  }

  static async findByStripeAccount(stripeAccountId: string) {
    return prisma.wallet.findUnique({ where: { stripeAccountId } });
  }

  static async balances(walletId: string): Promise<Balances> {
    return balancesIn(prisma, walletId);
  }

  /** Records the owner's payout account (Stripe Connect), once made. */
  static async setAccount(walletId: string, account: { provider: string; stripeAccountId: string; payoutsEnabled: boolean; detailsSubmitted: boolean }) {
    return prisma.wallet.update({ where: { id: walletId }, data: account });
  }

  static async setAccountStatus(walletId: string, status: { payoutsEnabled: boolean; detailsSubmitted: boolean }) {
    return prisma.wallet.update({ where: { id: walletId }, data: status });
  }

  static async listEntries(walletId: string, page: number, limit: number) {
    const where = { walletId };
    const [total, data] = await prisma.$transaction([
      prisma.walletLedgerEntry.count({ where }),
      prisma.walletLedgerEntry.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (page - 1) * limit, take: limit }),
    ]);
    return { total, data };
  }

  static async listEarnings(walletId: string, page: number, limit: number) {
    const where = { walletId };
    const [total, data] = await prisma.$transaction([
      prisma.earning.count({ where }),
      prisma.earning.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (page - 1) * limit, take: limit }),
    ]);
    return { total, data };
  }

  static async listWithdrawals(walletId: string, page: number, limit: number) {
    const where = { walletId };
    const [total, data] = await prisma.$transaction([
      prisma.withdrawal.count({ where }),
      prisma.withdrawal.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (page - 1) * limit, take: limit }),
    ]);
    return { total, data };
  }

  /** Every wallet, for the admin app, newest first. */
  static async listAll(page: number, limit: number) {
    const [total, data] = await prisma.$transaction([
      prisma.wallet.count(),
      prisma.wallet.findMany({ orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (page - 1) * limit, take: limit }),
    ]);
    return { total, data };
  }

  static async balancesFor(walletIds: string[]): Promise<Map<string, Balances>> {
    if (!walletIds.length) return new Map();
    const sums = await prisma.walletLedgerEntry.groupBy({ by: ["walletId", "bucket"], where: { walletId: { in: walletIds } }, _sum: { amountMinor: true } });
    const out = new Map(walletIds.map((id) => [id, { ...EMPTY }]));
    for (const s of sums) out.get(s.walletId)![s.bucket] = s._sum.amountMinor ?? 0;
    return out;
  }

  /** Earnings whose hold is over, not under dispute, still PENDING. */
  static async findReleasable(now: Date, take = 200) {
    return prisma.earning.findMany({ where: { status: "PENDING", disputed: false, availableAt: { lte: now } }, orderBy: { availableAt: "asc" }, take });
  }

  /** PENDING -> AVAILABLE for what's left of the earning after any reversal, once. Null when another
   * run (or a reversal) got there first. */
  static async release(earning: Earning, now: Date = new Date()): Promise<{ walletId: string } | null> {
    try {
      return await prisma.$transaction(async (tx) => {
        await lockWallet(tx, earning.walletId);
        const fresh = await tx.earning.findUnique({ where: { id: earning.id } });
        if (!fresh || fresh.status !== "PENDING" || fresh.disputed || fresh.availableAt > now) throw new MovedOn();
        const { count } = await tx.earning.updateMany({ where: { id: fresh.id, status: "PENDING", reversedMinor: fresh.reversedMinor }, data: { status: "AVAILABLE", releasedAt: now } });
        if (count !== 1) throw new MovedOn();
        const amountMinor = fresh.netMinor - fresh.reversedMinor;
        if (amountMinor > 0) {
          await move(tx, fresh.walletId, "PENDING", "AVAILABLE", { kind: "RELEASE", amountMinor, currency: fresh.currency, sourceId: fresh.id, key: `release:${fresh.id}` });
        }
        return { walletId: fresh.walletId };
      });
    } catch (err) {
      if (err instanceof MovedOn) return null;
      throw err;
    }
  }

  /**
   * Reserves a withdrawal: with the wallet row locked, checks the AVAILABLE balance and moves the
   * amount to RESERVED, recording the withdrawal PROCESSING. The same idempotency key returns the
   * withdrawal it already made. Refused BELOW_MINIMUM or INSUFFICIENT (with what's available).
   */
  static async reserveWithdrawal(input: {
    walletId: string;
    requestedById: string;
    amountMinor: number;
    currency: string;
    provider: string;
    idempotencyKey: string;
    minMinor: number;
  }): Promise<{ withdrawal: Withdrawal; existing: boolean } | { refused: "BELOW_MINIMUM" | "INSUFFICIENT"; available: number }> {
    return prisma.$transaction(async (tx) => {
      await lockWallet(tx, input.walletId);
      const existing = await tx.withdrawal.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (existing && existing.walletId === input.walletId) return { withdrawal: existing, existing: true };
      const { AVAILABLE: available } = await balancesIn(tx, input.walletId);
      if (input.amountMinor < input.minMinor) return { refused: "BELOW_MINIMUM" as const, available };
      if (input.amountMinor > available) return { refused: "INSUFFICIENT" as const, available };
      const withdrawal = await tx.withdrawal.create({
        data: {
          walletId: input.walletId,
          requestedById: input.requestedById,
          amountMinor: input.amountMinor,
          currency: input.currency,
          idempotencyKey: input.idempotencyKey,
          provider: input.provider,
          status: "PROCESSING",
        },
      });
      await move(tx, input.walletId, "AVAILABLE", "RESERVED", { kind: "WITHDRAWAL", amountMinor: withdrawal.amountMinor, currency: withdrawal.currency, sourceId: withdrawal.id, key: `withdrawal:${withdrawal.id}:reserve` });
      return { withdrawal, existing: false };
    });
  }

  static async findWithdrawal(id: string) {
    return prisma.withdrawal.findUnique({ where: { id } });
  }

  static async findWithdrawalByPayout(payoutId: string) {
    return prisma.withdrawal.findUnique({ where: { payoutId } });
  }

  /** Keeps the provider's transfer and payout ids on a withdrawal still PROCESSING. */
  static async setWithdrawalIds(id: string, ids: { transferId: string | null; payoutId: string | null }) {
    await prisma.withdrawal.updateMany({
      where: { id, status: "PROCESSING" },
      data: { ...(ids.transferId ? { transferId: ids.transferId } : {}), ...(ids.payoutId ? { payoutId: ids.payoutId } : {}) },
    });
  }

  /**
   * Ends a PROCESSING withdrawal, once: PAID moves the reserve to WITHDRAWN; FAILED puts it back in
   * AVAILABLE. Returns the withdrawal when this call ended it, null when it had already ended.
   */
  static async settleWithdrawal(id: string, outcome: { paid: true } | { paid: false; reason: string }, ids: { transferId?: string | null; payoutId?: string | null } = {}, now: Date = new Date()) {
    try {
      return await prisma.$transaction(async (tx) => {
        const withdrawal = await tx.withdrawal.findUnique({ where: { id } });
        if (!withdrawal) throw new MovedOn();
        await lockWallet(tx, withdrawal.walletId);
        const { count } = await tx.withdrawal.updateMany({
          where: { id, status: "PROCESSING" },
          data: {
            status: outcome.paid ? "PAID" : "FAILED",
            paidAt: outcome.paid ? now : null,
            failureReason: outcome.paid ? null : outcome.reason,
            ...(ids.transferId ? { transferId: ids.transferId } : {}),
            ...(ids.payoutId ? { payoutId: ids.payoutId } : {}),
          },
        });
        if (count !== 1) throw new MovedOn();
        await move(tx, withdrawal.walletId, "RESERVED", outcome.paid ? "WITHDRAWN" : "AVAILABLE", {
          kind: "WITHDRAWAL",
          amountMinor: withdrawal.amountMinor,
          currency: withdrawal.currency,
          sourceId: withdrawal.id,
          key: `withdrawal:${withdrawal.id}:${outcome.paid ? "paid" : "failed"}`,
        });
        return tx.withdrawal.findUniqueOrThrow({ where: { id } });
      });
    } catch (err) {
      if (err instanceof MovedOn) return null;
      throw err;
    }
  }
}
