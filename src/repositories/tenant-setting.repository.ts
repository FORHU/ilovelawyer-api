import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";

const SETTING_SELECT = {
  tenantId: true,
  value: true,
  updatedAt: true,
  updatedBy: { select: { name: true, email: true } },
} as const;

export default class TenantSettingRepo {
  static async find(tenantId: string, key: string) {
    return prisma.tenantSetting.findUnique({ where: { tenantId_key: { tenantId, key } }, select: SETTING_SELECT });
  }

  /** Every Tenant's row for one key — Tenants with no row are simply absent. */
  static async findAllForKey(key: string) {
    return prisma.tenantSetting.findMany({ where: { key }, select: SETTING_SELECT });
  }

  static async upsert(tenantId: string, key: string, value: Prisma.InputJsonValue, updatedById: string) {
    return prisma.tenantSetting.upsert({
      where: { tenantId_key: { tenantId, key } },
      create: { tenantId, key, value, updatedById },
      update: { value, updatedById },
      select: SETTING_SELECT,
    });
  }
}
