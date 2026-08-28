import prisma from "../lib/prisma";
import { TenantCode } from "../types/tenant-code";

export default class TenantRepo {
  /** Returns null rather than throwing if a TenantCode has no seeded Tenant row yet, so
   * callers can degrade gracefully instead of failing signup/org-creation over a seed-data
   * gap. See docs/adr/0004-collapse-jurisdiction-into-tenant.md. */
  static async findIdByCode(code: TenantCode): Promise<string | null> {
    const tenant = await prisma.tenant.findUnique({ where: { code }, select: { id: true } });
    return tenant?.id ?? null;
  }
}
