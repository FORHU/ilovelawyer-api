import { ClientPaymentKind, ClientPaymentStatus, ClientRefundStatus, Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import HttpError from "../utils/http-error";

export interface ClientBillingFilter {
  /** Inclusive. */
  from?: Date;
  /** Exclusive. */
  to?: Date;
  userId?: string;
  caseId?: string;
  status?: ClientPaymentStatus;
  kind?: ClientPaymentKind;
  /** DUMMY, STRIPE or FREE (ClientPayment.provider). */
  provider?: string;
  /** Part of the client's email or name, any case. */
  q?: string;
}

function toWhere(filter: ClientBillingFilter): Prisma.ClientPaymentWhereInput {
  const where: Prisma.ClientPaymentWhereInput = {};
  if (filter.userId) where.userId = filter.userId;
  if (filter.caseId) where.caseId = filter.caseId;
  if (filter.status) where.status = filter.status;
  if (filter.kind) where.kind = filter.kind;
  if (filter.provider) where.provider = filter.provider;
  if (filter.q) {
    where.user = { OR: [{ email: { contains: filter.q, mode: "insensitive" } }, { name: { contains: filter.q, mode: "insensitive" } }] };
  }
  if (filter.from || filter.to) where.createdAt = { ...(filter.from && { gte: filter.from }), ...(filter.to && { lt: filter.to }) };
  return where;
}

/** The same filter as raw SQL conditions on "ClientPayment" p (joined to "User" u), for the per-day query. */
function toSqlConditions(filter: ClientBillingFilter): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = [];
  if (filter.from) conditions.push(Prisma.sql`p."createdAt" >= ${filter.from}`);
  if (filter.to) conditions.push(Prisma.sql`p."createdAt" < ${filter.to}`);
  if (filter.userId) conditions.push(Prisma.sql`p."userId" = ${filter.userId}`);
  if (filter.caseId) conditions.push(Prisma.sql`p."caseId" = ${filter.caseId}`);
  if (filter.status) conditions.push(Prisma.sql`p."status" = ${filter.status}::"ClientPaymentStatus"`);
  if (filter.kind) conditions.push(Prisma.sql`p."kind" = ${filter.kind}::"ClientPaymentKind"`);
  if (filter.provider) conditions.push(Prisma.sql`p."provider" = ${filter.provider}`);
  if (filter.q) {
    const like = `%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conditions.push(Prisma.sql`(u."email" ILIKE ${like} OR u."name" ILIKE ${like})`);
  }
  return conditions;
}

/** Refunds that hold money: SUCCEEDED, and PENDING ones still on their way. */
const HOLDING: ClientRefundStatus[] = ["PENDING", "SUCCEEDED"];

const PAYMENT_INCLUDE = {
  user: { select: { id: true, email: true, name: true } },
  case: { select: { id: true, caseName: true } },
  refunds: { orderBy: { createdAt: "desc" } },
} satisfies Prisma.ClientPaymentInclude;

export type AdminClientPaymentRow = Prisma.ClientPaymentGetPayload<{ include: typeof PAYMENT_INCLUDE }>;

export interface MoneyGroup {
  key: string | null;
  currency: string;
  amountMinor: number;
  payments: number;
}

export interface MoneyDayRow {
  day: Date;
  currency: string;
  amountMinor: number;
  payments: number;
}

export default class ClientBillingAdminRepo {
  /** Newest first, with the client, the case and the refunds. */
  static async list(filter: ClientBillingFilter, take: number, skip: number): Promise<AdminClientPaymentRow[]> {
    return prisma.clientPayment.findMany({ where: toWhere(filter), include: PAYMENT_INCLUDE, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take, skip });
  }

  static async count(filter: ClientBillingFilter) {
    return prisma.clientPayment.count({ where: toWhere(filter) });
  }

  static async findById(id: string): Promise<AdminClientPaymentRow | null> {
    return prisma.clientPayment.findUnique({ where: { id }, include: PAYMENT_INCLUDE });
  }

  static async findClient(userId: string) {
    return prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, name: true, role: true, createdAt: true } });
  }

  /** The client's cases with a balance or a payment on them, and their credits left. */
  static async clientCases(userId: string) {
    return prisma.case.findMany({
      where: { userId, clientPayments: { some: {} } },
      select: { id: true, caseName: true, clientCredits: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    });
  }

  /** SUCCEEDED payments in the filter, summed per value of `by` and currency. */
  static async paidBy(filter: ClientBillingFilter, by: "kind" | "provider" | null): Promise<MoneyGroup[]> {
    const where = { AND: [toWhere(filter), { status: ClientPaymentStatus.SUCCEEDED }] };
    const rows = await prisma.clientPayment.groupBy({
      by: by ? [by, "currency"] : ["currency"],
      where,
      _sum: { amountMinor: true },
      _count: { _all: true },
    });
    return rows.map((row) => ({
      key: by ? ((row as Record<string, unknown>)[by] as string) : null,
      currency: row.currency,
      amountMinor: row._sum.amountMinor ?? 0,
      payments: row._count._all,
    }));
  }

  /** Every payment in the filter counted by status, whatever its outcome. */
  static async countByStatus(filter: ClientBillingFilter) {
    const rows = await prisma.clientPayment.groupBy({ by: ["status"], where: toWhere(filter), _count: { _all: true } });
    return Object.fromEntries(rows.map((row) => [row.status, row._count._all])) as Partial<Record<ClientPaymentStatus, number>>;
  }

  /** Refunds of the payments in the filter, per status and currency. */
  static async refundsOf(filter: ClientBillingFilter) {
    const rows = await prisma.clientRefund.groupBy({
      by: ["status", "currency"],
      where: { payment: { is: toWhere(filter) } },
      _sum: { amountMinor: true },
      _count: { _all: true },
    });
    return rows.map((row) => ({ status: row.status, currency: row.currency, amountMinor: row._sum.amountMinor ?? 0, refunds: row._count._all }));
  }

  /** SUCCEEDED payments in the filter per UTC day and currency. */
  static async paidByDay(filter: ClientBillingFilter): Promise<MoneyDayRow[]> {
    const conditions = [...toSqlConditions(filter), Prisma.sql`p."status" = 'SUCCEEDED'::"ClientPaymentStatus"`];
    const rows = await prisma.$queryRaw<{ day: Date; currency: string; amountMinor: bigint | null; payments: bigint }[]>(Prisma.sql`
      SELECT date_trunc('day', p."createdAt") AS "day", p."currency", SUM(p."amountMinor") AS "amountMinor", COUNT(*) AS "payments"
      FROM "ClientPayment" p JOIN "User" u ON u."id" = p."userId"
      WHERE ${Prisma.join(conditions, " AND ")}
      GROUP BY 1, 2 ORDER BY 1 ASC`);
    return rows.map((row) => ({ day: row.day, currency: row.currency, amountMinor: Number(row.amountMinor ?? 0), payments: Number(row.payments) }));
  }

  /**
   * Records a refund before it goes to Stripe, holding the payment's row so two admins refunding at
   * the same moment can't together give back more than was paid. A null amount takes what's left.
   * Throws 400 REFUND_EXCEEDS_PAYMENT when the amount is more than what's left, 409
   * ALREADY_REFUNDED when nothing is.
   */
  static async startRefund(input: { paymentId: string; amountMinor: number | null; reason: string; adminId: string }) {
    return prisma.$transaction(async (tx) => {
      const [payment] = await tx.$queryRaw<{ amountMinor: number; currency: string }[]>(
        Prisma.sql`SELECT "amountMinor", "currency" FROM "ClientPayment" WHERE "id" = ${input.paymentId} FOR UPDATE`,
      );
      if (!payment) throw new HttpError("Payment not found", 404);
      const held = await tx.clientRefund.aggregate({ where: { paymentId: input.paymentId, status: { in: HOLDING } }, _sum: { amountMinor: true } });
      const left = payment.amountMinor - (held._sum.amountMinor ?? 0);
      if (left <= 0) throw new HttpError("This payment has already been refunded in full", 409, "ALREADY_REFUNDED");
      const amountMinor = input.amountMinor ?? left;
      if (amountMinor > left) {
        throw new HttpError(`Only ${left} (minor units) of this payment is left to refund`, 400, "REFUND_EXCEEDS_PAYMENT");
      }
      return tx.clientRefund.create({
        data: { paymentId: input.paymentId, amountMinor, currency: payment.currency, reason: input.reason, status: "PENDING", adminId: input.adminId },
      });
    });
  }

  static async updateRefund(id: string, data: { status: ClientRefundStatus; externalId?: string | null; failureReason?: string | null }) {
    return prisma.clientRefund.update({ where: { id }, data });
  }

  /** A refund Stripe tells us about (refund.updated / refund.failed), by our id in its metadata or its
   * own id. Null for a refund this server didn't issue. */
  static async findRefund(refundId: string | undefined, externalId: string) {
    if (refundId) {
      const byId = await prisma.clientRefund.findUnique({ where: { id: refundId } });
      if (byId) return byId;
    }
    return prisma.clientRefund.findFirst({ where: { externalId } });
  }

  /** Names for the admins who issued refunds (no foreign key: a deleted admin has none). */
  static async findUserNames(ids: string[]) {
    if (!ids.length) return [];
    return prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } });
  }
}
