import prisma from "../../src/lib/prisma";
import { PAYMENT_PLAN_DEFAULT_TIERS } from "../../src/constants/tenant-settings.constants";
import { CLIENT_PRICING_DEFAULTS } from "../../src/constants/client-pricing.constants";

// The deployment-region boundary Tenant rows — see docs/adr/0002-tenant-region-boundary.md.
// `code` matches the Jurisdiction enum / subdomain convention already used by
// jurisdiction-host.ts ("PH", "UK"). Idempotent — upserts on code, safe to re-run.
const TENANTS = [
  { code: "PH", name: "Philippines" },
  { code: "UK", name: "United Kingdom" },
] as const;

export async function seedTenants() {
  for (const tenant of TENANTS) {
    const { id: tenantId } = await prisma.tenant.upsert({
      where: { code: tenant.code },
      update: { name: tenant.name },
      create: tenant,
    });

    // A fresh database runs the payment_plan_tiers migration before any Tenant exists, so its
    // backfill seeds nothing — without these, every lawyer would have no tier and be locked.
    // Create-only: a tier an admin has since edited is left as it is. createdAt === updatedAt is
    // how the admin Settings page tells a never-edited default tier, same as the migration's rows.
    for (const tier of PAYMENT_PLAN_DEFAULT_TIERS) {
      const now = new Date();
      await prisma.paymentPlan.upsert({
        where: { tenantId_planType_code: { tenantId, planType: "B2B_SUBSCRIPTION", code: tier.code } },
        update: {},
        create: { tenantId, planType: "B2B_SUBSCRIPTION", ...tier, createdAt: now, updatedAt: now },
      });
    }

    // The client app's prices, same create-only rule (client_pricing_seed seeded the tenants that
    // existed when it ran).
    const { currency } = CLIENT_PRICING_DEFAULTS;
    const b2c = [
      { planType: "B2C_CASE" as const, ...CLIENT_PRICING_DEFAULTS.case, isDefault: false },
      ...CLIENT_PRICING_DEFAULTS.packs.map((p) => ({ planType: "B2C_TOP_UP" as const, ...p })),
    ];
    for (const { planType, code, ...row } of b2c) {
      const now = new Date();
      await prisma.paymentPlan.upsert({
        where: { tenantId_planType_code: { tenantId, planType, code } },
        update: {},
        create: { tenantId, planType, code, ...row, currency, feeUsd: 0, includedAllowanceUsd: 0, caseLimit: 0, createdAt: now, updatedAt: now },
      });
    }
    for (const promo of CLIENT_PRICING_DEFAULTS.promos) {
      const now = new Date();
      await prisma.clientPromo.upsert({
        where: { tenantId_code: { tenantId, code: promo.code } },
        update: {},
        create: { tenantId, ...promo, currency, createdAt: now, updatedAt: now },
      });
    }
  }

  console.log(`Seeded tenants and their default subscription tiers and client prices: ${TENANTS.map((t) => t.code).join(", ")}`);
}
