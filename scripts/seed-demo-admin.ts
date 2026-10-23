/**
 * Local-demo only, not for commit: seeds an ADMIN account with a known password so the admin app
 * (ilovelawyer-admin) can be logged into locally.
 *
 *   npx ts-node --files scripts/seed-demo-admin.ts
 */
import bcrypt from "bcrypt";
import prisma from "../src/lib/prisma";
import { BCRYPT_SALT_ROUNDS } from "../src/constants/auth.constants";

const EMAIL = "demo.admin@example.com";
const PASSWORD = "Demo-Admin-123!";

async function main() {
  const passwordHash = await bcrypt.hash(PASSWORD, BCRYPT_SALT_ROUNDS);
  await prisma.user.upsert({
    where: { email: EMAIL },
    update: {},
    create: {
      email: EMAIL,
      password: passwordHash,
      name: "Demo Admin",
      username: "demo-admin",
      role: "ADMIN",
      isEmailVerified: true,
      approvalStatus: "ACTIVE",
      onboardingCompleted: true,
      termsAcceptedAt: new Date(),
      termsVersion: "seed",
      freeCreditUsd: null,
    },
  });
  console.log(`Admin: ${EMAIL} / ${PASSWORD}`);
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
