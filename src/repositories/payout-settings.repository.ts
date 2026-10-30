import prisma from "../lib/prisma";

export interface PayoutSettingsPatch {
  platformFeeBps?: number;
  minPlatformFeeMinor?: number;
  earningsHoldDays?: number;
  minWithdrawalMinor?: number;
}

/** A tenant's quotation payment terms (PayoutSettings), one row per tenant; none means the defaults. */
export default class PayoutSettingsRepo {
  static async find(tenantId: string) {
    return prisma.payoutSettings.findUnique({ where: { tenantId } });
  }

  static async listAll() {
    return prisma.payoutSettings.findMany();
  }

  /** Writes the patch over what's there, starting from `base` (the defaults) when the tenant has no row. */
  static async upsert(tenantId: string, base: Required<PayoutSettingsPatch>, patch: PayoutSettingsPatch, adminId: string) {
    return prisma.payoutSettings.upsert({
      where: { tenantId },
      create: { tenantId, ...base, ...patch, updatedById: adminId },
      update: { ...patch, updatedById: adminId },
    });
  }
}
