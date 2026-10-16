/**
 * Deletes landing-page trial guests (User.trialExpiresAt, see TrialSvc) whose trial has ended, with
 * everything they made, through the same purge as an account deletion. Run it on a schedule, or
 * after an event:
 *   Dry run (default):  node dist/scripts/purge-trial-users.js
 *   Do it:              node dist/scripts/purge-trial-users.js --apply
 * From a checkout: npx ts-node src/scripts/purge-trial-users.ts [--apply]
 */
import prisma from "../lib/prisma";
import AccountDeletionSvc from "../services/account-deletion.service";

async function main() {
  const apply = process.argv.includes("--apply");
  const expired = await prisma.user.findMany({ where: { trialExpiresAt: { lt: new Date() } }, select: { id: true } });
  console.log(`${expired.length} expired trial guest(s)${apply ? "" : " (dry run, pass --apply to delete)"}`);
  if (!apply) return;
  for (const { id } of expired) await AccountDeletionSvc.purge(id);
  console.log("Deleted.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
