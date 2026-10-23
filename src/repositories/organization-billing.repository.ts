import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import type { SavedCard } from "../payments/organization-card-provider";

/** Who a card is on file for and charged to: a law firm (OrganizationBilling), or a solo lawyer, who
 * has no organization and keeps their own card (UserBilling, docs/adr/0022). */
export type Payer = { organizationId: string } | { userId: string };

export function isFirm(payer: Payer): payer is { organizationId: string } {
  return "organizationId" in payer;
}

/** The payer for a charge or card setup: the firm when there is one, else the solo lawyer. */
export function payerOf(organizationId: string | null | undefined, lawyerId: string | null | undefined): Payer | null {
  if (organizationId) return { organizationId };
  return lawyerId ? { userId: lawyerId } : null;
}

export default class OrganizationBillingRepo {
  static async find(payer: Payer) {
    return isFirm(payer)
      ? prisma.organizationBilling.findUnique({ where: { organizationId: payer.organizationId } })
      : prisma.userBilling.findUnique({ where: { userId: payer.userId } });
  }

  /** The name the payment provider's customer is made with: the firm's, or the lawyer's own. Null when gone. */
  static async findPayerName(payer: Payer): Promise<string | null> {
    if (isFirm(payer)) {
      return (await prisma.organization.findUnique({ where: { id: payer.organizationId }, select: { name: true } }))?.name ?? null;
    }
    const user = await prisma.user.findUnique({ where: { id: payer.userId }, select: { name: true, email: true } });
    return user ? user.name || user.email : null;
  }

  static async findEmail(userId: string): Promise<string | null> {
    return (await prisma.user.findUnique({ where: { id: userId }, select: { email: true } }))?.email ?? null;
  }

  /** Keeps the payer's Stripe customer, made on its first setup, without touching its card. */
  static async setCustomer(payer: Payer, customerId: string) {
    if (isFirm(payer)) {
      const { organizationId } = payer;
      await prisma.organizationBilling.upsert({
        where: { organizationId },
        create: { organizationId, provider: "STRIPE", customerId },
        update: { customerId },
      });
      return;
    }
    const { userId } = payer;
    await prisma.userBilling.upsert({ where: { userId }, create: { userId, provider: "STRIPE", customerId }, update: { customerId } });
  }

  /**
   * Puts a card on file, once per setup session: the row is held while it's compared, so the webhook
   * and the app coming back at the same moment can't both apply it. Returns whether this call did,
   * and the card it replaced (for the provider to remove).
   */
  static async saveCard(
    payer: Payer,
    input: { provider: string; card: SavedCard; setupSessionId: string | null; updatedById: string | null },
  ): Promise<{ applied: boolean; replaced: { provider: string; paymentMethodId: string } | null }> {
    return prisma.$transaction(async (tx) => {
      const locked = isFirm(payer)
        ? Prisma.sql`SELECT "provider", "paymentMethodId", "setupSessionId" FROM "OrganizationBilling" WHERE "organizationId" = ${payer.organizationId} FOR UPDATE`
        : Prisma.sql`SELECT "provider", "paymentMethodId", "setupSessionId" FROM "UserBilling" WHERE "userId" = ${payer.userId} FOR UPDATE`;
      const [row] = await tx.$queryRaw<{ provider: string; paymentMethodId: string | null; setupSessionId: string | null }[]>(locked);
      if (row && input.setupSessionId && row.setupSessionId === input.setupSessionId) return { applied: false, replaced: null };
      const data = {
        provider: input.provider,
        paymentMethodId: input.card.paymentMethodId,
        brand: input.card.brand,
        last4: input.card.last4,
        expMonth: input.card.expMonth,
        expYear: input.card.expYear,
        setupSessionId: input.setupSessionId,
        ...(input.card.customerId ? { customerId: input.card.customerId } : {}),
      };
      if (isFirm(payer)) {
        const { organizationId } = payer;
        const firmData = { ...data, updatedById: input.updatedById };
        if (row) await tx.organizationBilling.update({ where: { organizationId }, data: firmData });
        else await tx.organizationBilling.create({ data: { organizationId, ...firmData } });
      } else {
        const { userId } = payer;
        if (row) await tx.userBilling.update({ where: { userId }, data });
        else await tx.userBilling.create({ data: { userId, ...data } });
      }
      const replaced =
        row?.paymentMethodId && row.paymentMethodId !== input.card.paymentMethodId ? { provider: row.provider, paymentMethodId: row.paymentMethodId } : null;
      return { applied: true, replaced };
    });
  }
}
