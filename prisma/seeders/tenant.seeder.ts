import prisma from "../../src/lib/prisma";

// The deployment-region boundary Tenant rows — see docs/adr/0002-tenant-region-boundary.md.
// `code` matches the Jurisdiction enum / subdomain convention already used by
// jurisdiction-host.ts ("PH", "UK"). Idempotent — upserts on code, safe to re-run.
const TENANTS = [
  { code: "PH", name: "Philippines" },
  { code: "UK", name: "United Kingdom" },
] as const;

export async function seedTenants() {
  for (const tenant of TENANTS) {
    await prisma.tenant.upsert({
      where: { code: tenant.code },
      update: { name: tenant.name },
      create: tenant,
    });
  }

  console.log(`Seeded tenants: ${TENANTS.map((t) => t.code).join(", ")}`);
}
