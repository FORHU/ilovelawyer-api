import { ClientRequestStatus, OrganizationChargeRefundStatus, OrganizationChargeStatus, Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import HttpError from "../utils/http-error";

export interface AdminRequestFilter {
  status?: ClientRequestStatus;
  /** Made at least this many hours ago. */
  minAgeHours?: number;
  /** Still ROUTED with its 48h routing window over: nobody claimed it in time (#510's sweep may not
   * have expired it yet). */
  unclaimedOver48h?: boolean;
  /** One case's requests. */
  caseId?: string;
}

/** Charges that took money: what refunds can come from, and what the summary counts as paid. */
export const PAID_CHARGE_STATUSES: OrganizationChargeStatus[] = ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"];
/** Refunds that hold money: SUCCEEDED, and PENDING ones still on their way. */
const HOLDING: OrganizationChargeRefundStatus[] = ["PENDING", "SUCCEEDED"];

const FOR_ADMIN = {
  case: { select: { practiceArea: true, ukJurisdiction: true } },
  claims: {
    orderBy: { claimedAt: "desc" },
    include: { lawyer: { select: { id: true, name: true, email: true } }, organization: { select: { id: true, name: true } } },
  },
  charges: { orderBy: { createdAt: "desc" }, include: { refunds: { orderBy: { createdAt: "desc" } } } },
} satisfies Prisma.ClientRequestInclude;

export type AdminRequestRow = Prisma.ClientRequestGetPayload<{ include: typeof FOR_ADMIN }>;

export type ChargeWithRefunds = Prisma.OrganizationChargeGetPayload<{ include: { refunds: true } }>;

function toWhere(filter: AdminRequestFilter, now: Date): Prisma.ClientRequestWhereInput {
  const where: Prisma.ClientRequestWhereInput[] = [];
  if (filter.status) where.push({ status: filter.status });
  if (filter.caseId) where.push({ caseId: filter.caseId });
  if (filter.minAgeHours !== undefined) where.push({ createdAt: { lte: new Date(now.getTime() - filter.minAgeHours * 60 * 60 * 1000) } });
  if (filter.unclaimedOver48h) where.push({ status: "ROUTED", routingExpiresAt: { lte: now } });
  return where.length ? { AND: where } : {};
}

export interface FeesSummaryRow {
  key: string;
  /** Per organization: the row is a solo lawyer (no organization), `key` their id. */
  solo: boolean;
  engagements: number;
  perCaseFees: number;
  topUps: number;
  refunds: number;
}

/** Platform admins' view of the client hand-off (#520): every request, the fees per firm or lawyer,
 * and refunds of the firms' charges. */
export default class ClientRequestAdminRepo {
  /** Newest first, with the case's area, every claim (lawyer and firm), and the charges. */
  static async listRequests(filter: AdminRequestFilter, page: number, limit: number, now: Date = new Date()) {
    const where = toWhere(filter, now);
    const [total, data] = await prisma.$transaction([
      prisma.clientRequest.count({ where }),
      prisma.clientRequest.findMany({ where, include: FOR_ADMIN, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (page - 1) * limit, take: limit }),
    ]);
    return { total, data };
  }

  /**
   * Paid charges in [from, to) per organization or lawyer: engagements (paid per-case fees), the fees,
   * the AI top-ups, and what's been refunded of them. A refunded charge still counts as paid, and its
   * refunds show separately. Most fees first. Per organization, a solo lawyer's charges (no
   * organization, docs/adr/0022) are grouped under the lawyer, with `solo` set.
   */
  static async feesSummary(groupBy: "organization" | "lawyer", from: Date | undefined, to: Date | undefined): Promise<FeesSummaryRow[]> {
    const column = Prisma.raw(groupBy === "organization" ? `COALESCE(c."organizationId", c."lawyerId")` : `c."lawyerId"`);
    const conditions = [
      Prisma.sql`c."status" IN (${Prisma.join(PAID_CHARGE_STATUSES.map((s) => Prisma.sql`${s}::"OrganizationChargeStatus"`))})`,
      Prisma.sql`${column} IS NOT NULL`,
      ...(from ? [Prisma.sql`c."createdAt" >= ${from}`] : []),
      ...(to ? [Prisma.sql`c."createdAt" < ${to}`] : []),
    ];
    const rows = await prisma.$queryRaw<{ key: string; solo: boolean; engagements: bigint; perCaseFees: bigint | null; topUps: bigint | null; refunds: bigint | null }[]>(Prisma.sql`
      SELECT ${column} AS "key",
             BOOL_OR(c."organizationId" IS NULL) AS "solo",
             COUNT(*) FILTER (WHERE c."kind" = 'PER_CASE_FEE'::"OrganizationChargeKind") AS "engagements",
             SUM(c."amountMinor") FILTER (WHERE c."kind" = 'PER_CASE_FEE'::"OrganizationChargeKind") AS "perCaseFees",
             SUM(c."amountMinor") FILTER (WHERE c."kind" = 'AI_TOP_UP'::"OrganizationChargeKind") AS "topUps",
             SUM(r."refunded") AS "refunds"
      FROM "OrganizationCharge" c
      LEFT JOIN (
        SELECT "chargeId", SUM("amountMinor") AS "refunded" FROM "OrganizationChargeRefund"
        WHERE "status" = 'SUCCEEDED'::"OrganizationChargeRefundStatus" GROUP BY 1
      ) r ON r."chargeId" = c."id"
      WHERE ${Prisma.join(conditions, " AND ")}
      GROUP BY 1
      ORDER BY "perCaseFees" DESC NULLS LAST, 1 ASC`);
    return rows.map((r) => ({
      key: r.key,
      solo: groupBy === "organization" && r.solo,
      engagements: Number(r.engagements),
      perCaseFees: Number(r.perCaseFees ?? 0),
      topUps: Number(r.topUps ?? 0),
      refunds: Number(r.refunds ?? 0),
    }));
  }

  static async findOrganizationNames(ids: string[]) {
    if (!ids.length) return [];
    return prisma.organization.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  }

  static async findUserNames(ids: string[]) {
    if (!ids.length) return [];
    return prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } });
  }

  static async findCharge(id: string): Promise<ChargeWithRefunds | null> {
    return prisma.organizationCharge.findUnique({ where: { id }, include: { refunds: { orderBy: { createdAt: "desc" } } } });
  }

  /**
   * Records a refund before it goes to Stripe, holding the charge's row so two admins refunding at the
   * same moment can't together give back more than was paid. A null amount takes what's left. 409
   * ALREADY_REFUNDED when nothing is left, 400 REFUND_EXCEEDS_CHARGE when the amount is more.
   */
  static async startRefund(input: { chargeId: string; amountMinor: number | null; reason: string; adminId: string }) {
    return prisma.$transaction(async (tx) => {
      const [charge] = await tx.$queryRaw<{ amountMinor: number; currency: string }[]>(
        Prisma.sql`SELECT "amountMinor", "currency" FROM "OrganizationCharge" WHERE "id" = ${input.chargeId} FOR UPDATE`,
      );
      if (!charge) throw new HttpError("Charge not found", 404);
      const held = await tx.organizationChargeRefund.aggregate({ where: { chargeId: input.chargeId, status: { in: HOLDING } }, _sum: { amountMinor: true } });
      const left = charge.amountMinor - (held._sum.amountMinor ?? 0);
      if (left <= 0) throw new HttpError("This charge has already been refunded in full", 409, "ALREADY_REFUNDED");
      const amountMinor = input.amountMinor ?? left;
      if (amountMinor > left) throw new HttpError(`Only ${left} (minor units) of this charge is left to refund`, 400, "REFUND_EXCEEDS_CHARGE", { leftMinor: left });
      return tx.organizationChargeRefund.create({
        data: { chargeId: input.chargeId, amountMinor, currency: charge.currency, reason: input.reason, status: "PENDING", adminId: input.adminId },
      });
    });
  }

  /**
   * Updates a refund and brings its charge's status in line: REFUNDED once refunds that went through
   * add up to all of it, PARTIALLY_REFUNDED for some, SUCCEEDED for none. One transaction, charge row
   * first, so two refunds settling at once agree on the total.
   */
  static async updateRefund(id: string, data: { status: OrganizationChargeRefundStatus; externalId?: string | null; failureReason?: string | null }) {
    return prisma.$transaction(async (tx) => {
      const refund = await tx.organizationChargeRefund.findUniqueOrThrow({ where: { id }, select: { chargeId: true } });
      const [charge] = await tx.$queryRaw<{ amountMinor: number; status: OrganizationChargeStatus }[]>(
        Prisma.sql`SELECT "amountMinor", "status" FROM "OrganizationCharge" WHERE "id" = ${refund.chargeId} FOR UPDATE`,
      );
      const updated = await tx.organizationChargeRefund.update({ where: { id }, data });
      if (charge && PAID_CHARGE_STATUSES.includes(charge.status)) {
        const done = await tx.organizationChargeRefund.aggregate({ where: { chargeId: refund.chargeId, status: "SUCCEEDED" }, _sum: { amountMinor: true } });
        const refunded = done._sum.amountMinor ?? 0;
        const status: OrganizationChargeStatus = refunded >= charge.amountMinor ? "REFUNDED" : refunded > 0 ? "PARTIALLY_REFUNDED" : "SUCCEEDED";
        if (status !== charge.status) await tx.organizationCharge.update({ where: { id: refund.chargeId }, data: { status } });
      }
      return updated;
    });
  }

  /** A refund Stripe tells us about, by our id in its metadata or its own id. Null for one we didn't
   * issue. */
  static async findRefund(refundId: string | undefined, externalId: string) {
    if (refundId) {
      const byId = await prisma.organizationChargeRefund.findUnique({ where: { id: refundId } });
      if (byId) return byId;
    }
    return prisma.organizationChargeRefund.findFirst({ where: { externalId } });
  }
}
