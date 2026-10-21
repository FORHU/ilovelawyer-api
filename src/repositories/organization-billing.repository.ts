import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";
import type { SavedCard } from "../payments/organization-card-provider";

export default class OrganizationBillingRepo {
  static async find(organizationId: string) {
    return prisma.organizationBilling.findUnique({ where: { organizationId } });
  }

  static async findOrganization(organizationId: string) {
    return prisma.organization.findUnique({ where: { id: organizationId }, select: { id: true, name: true } });
  }

  static async findEmail(userId: string): Promise<string | null> {
    return (await prisma.user.findUnique({ where: { id: userId }, select: { email: true } }))?.email ?? null;
  }

  /** Keeps the organization's Stripe customer, made on its first setup, without touching its card. */
  static async setCustomer(organizationId: string, customerId: string) {
    await prisma.organizationBilling.upsert({
      where: { organizationId },
      create: { organizationId, provider: "STRIPE", customerId },
      update: { customerId },
    });
  }

  /**
   * Puts a card on file, once per setup session: the row is held while it's compared, so the webhook
   * and the app coming back at the same moment can't both apply it. Returns whether this call did,
   * and the card it replaced (for the provider to remove).
   */
  static async saveCard(
    organizationId: string,
    input: { provider: string; card: SavedCard; setupSessionId: string | null; updatedById: string | null },
  ): Promise<{ applied: boolean; replaced: { provider: string; paymentMethodId: string } | null }> {
    return prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<{ provider: string; paymentMethodId: string | null; setupSessionId: string | null }[]>(
        Prisma.sql`SELECT "provider", "paymentMethodId", "setupSessionId" FROM "OrganizationBilling" WHERE "organizationId" = ${organizationId} FOR UPDATE`,
      );
      if (row && input.setupSessionId && row.setupSessionId === input.setupSessionId) return { applied: false, replaced: null };
      const data = {
        provider: input.provider,
        paymentMethodId: input.card.paymentMethodId,
        brand: input.card.brand,
        last4: input.card.last4,
        expMonth: input.card.expMonth,
        expYear: input.card.expYear,
        setupSessionId: input.setupSessionId,
        updatedById: input.updatedById,
        ...(input.card.customerId ? { customerId: input.card.customerId } : {}),
      };
      if (row) await tx.organizationBilling.update({ where: { organizationId }, data });
      else await tx.organizationBilling.create({ data: { organizationId, ...data } });
      const replaced =
        row?.paymentMethodId && row.paymentMethodId !== input.card.paymentMethodId ? { provider: row.provider, paymentMethodId: row.paymentMethodId } : null;
      return { applied: true, replaced };
    });
  }
}
