import bcrypt from "bcrypt";
import prisma from "../../src/lib/prisma";
import { SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD } from "../../src/config";
import { BCRYPT_SALT_ROUNDS } from "../../src/constants/auth.constants";

// Bootstraps the first admin account. Necessary because Admin Approval has no bootstrap
// path otherwise: a brand-new User starts PENDING, and PENDING users can't approve
// anyone — including themselves — from the admin app. Idempotent — upserts on email,
// safe to re-run.
export async function seedAdmin() {
  if (!SEED_ADMIN_EMAIL || !SEED_ADMIN_PASSWORD) {
    throw new Error("SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must be set in .env to seed the admin account");
  }

  const email = SEED_ADMIN_EMAIL;
  const password = SEED_ADMIN_PASSWORD;
  const hashedPassword = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);

  const admin = await prisma.user.upsert({
    where: { email },
    update: {
      role: "ADMIN",
      approvalStatus: "ACTIVE",
      isEmailVerified: true,
    },
    create: {
      username: "admin",
      email,
      password: hashedPassword,
      name: "Admin",
      role: "ADMIN",
      isEmailVerified: true,
      approvalStatus: "ACTIVE",
    },
  });

  console.log(`Seeded admin user: ${admin.email} (password: ${password} if newly created)`);
}
