import prisma from "../src/lib/prisma";
import { seedAdmin } from "./seeders/admin.seeder";
import { seedTenants } from "./seeders/tenant.seeder";

// Runs automatically after `prisma migrate reset` (see package.json's `prisma.seed`),
// or on demand via `npm run prisma:seed`. Each seeder is independently idempotent —
// see prisma/seeders/*.seeder.ts.
async function main() {
  await seedAdmin();
  await seedTenants();
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
