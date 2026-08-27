import prisma from "../lib/prisma";
import { Jurisdiction } from "@prisma/client";

export default class TenantRepo {
  /** Tenant.code matches the Jurisdiction enum 1:1 today (PH, UK) — see
   * docs/adr/0002-tenant-region-boundary.md. Returns null rather than throwing if a
   * Jurisdiction value has no seeded Tenant row yet, so callers can degrade gracefully
   * instead of failing signup/org-creation over a seed-data gap. */
  static async findIdByJurisdiction(jurisdiction: Jurisdiction): Promise<string | null> {
    const tenant = await prisma.tenant.findUnique({ where: { code: jurisdiction }, select: { id: true } });
    return tenant?.id ?? null;
  }
}
