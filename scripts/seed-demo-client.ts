/**
 * Local-demo only, not for commit: seeds a USER-role (client) account with a known password so
 * ilovelawyer-client can be logged into locally. A LAWYER or ADMIN account always 403s
 * CLIENT_ACCOUNT_ONLY on /api/client/* (see requireClientAccount) — this is the account that
 * actually passes that check.
 *
 *   npx ts-node --files scripts/seed-demo-client.ts
 */
import bcrypt from "bcrypt";
import prisma from "../src/lib/prisma";
import { BCRYPT_SALT_ROUNDS } from "../src/constants/auth.constants";

const EMAIL = "demo.client@example.com";
const PASSWORD = "Demo-Client-123!";
const UK_TENANT_CODE = "UK";

async function main() {
  const tenant = await prisma.tenant.findUnique({ where: { code: UK_TENANT_CODE } });
  const passwordHash = await bcrypt.hash(PASSWORD, BCRYPT_SALT_ROUNDS);
  await prisma.user.upsert({
    where: { email: EMAIL },
    update: { role: "USER", isEmailVerified: true, approvalStatus: "ACTIVE", onboardingCompleted: true },
    create: {
      email: EMAIL,
      password: passwordHash,
      name: "Demo Client",
      username: "demo-client",
      role: "USER",
      tenantId: tenant?.id ?? null,
      isEmailVerified: true,
      approvalStatus: "ACTIVE",
      onboardingCompleted: true,
      termsAcceptedAt: new Date(),
      termsVersion: "seed",
      freeCreditUsd: null,
    },
  });
  console.log(`Client: ${EMAIL} / ${PASSWORD}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit();
  });
