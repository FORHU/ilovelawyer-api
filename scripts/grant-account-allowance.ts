/**
 * Staff only. Adds to one lawyer's account-wide AI allowance when they've asked us for more
 * (cases aren't billed individually — the allowance is shared across every case the account owns).
 * The standard allowance is internal and is never shown as a bare ceiling; run this on request and
 * tell the lawyer only that their account is open for more work.
 *
 *   npx ts-node --files scripts/grant-account-allowance.ts --user <user id> [--usd 20]
 *
 * --usd defaults to 20 and is added to what the account already has. Run against the environment
 * the account lives in (DATABASE_URL in .env).
 */
import prisma from "../src/lib/prisma";
import AccountLimitsSvc from "../src/services/account-limits.service";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

async function main() {
  const userId = arg("user");
  const usd = Number(arg("usd") ?? 20);
  if (!userId) throw new Error("--user <user id> is required");
  if (!Number.isFinite(usd) || usd <= 0) throw new Error("--usd must be a positive number");
  const before = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, role: true, extraAiAllowanceUsd: true } });
  if (!before) throw new Error(`No user ${userId} in this database`);
  const updated = await AccountLimitsSvc.grantExtraAllowance(userId, usd);
  console.log(`${updated.email} (${before.role}): extra allowance ${before.extraAiAllowanceUsd} -> ${updated.extraAiAllowanceUsd}`);
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
