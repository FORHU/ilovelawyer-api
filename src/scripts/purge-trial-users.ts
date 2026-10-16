/**
 * Deletes landing-page trial guests (User.trialExpiresAt, see TrialSvc) whose trial has ended, with
 * their workspace and everything in it (TrialSvc.purgeExpired). TrialGuestPurgeQueue does this
 * every three days; this runs it on demand, e.g. right after an event:
 *   Dry run (default):  node dist/scripts/purge-trial-users.js
 *   Do it:              node dist/scripts/purge-trial-users.js --apply
 * From a checkout: npx ts-node src/scripts/purge-trial-users.ts [--apply]
 */
import prisma from "../lib/prisma";
import TrialSvc from "../services/trial.service";

async function main() {
  const apply = process.argv.includes("--apply");
  if (!apply) {
    const count = await prisma.user.count({ where: { trialExpiresAt: { lt: new Date() } } });
    console.log(`${count} expired trial guest(s) (dry run, pass --apply to delete)`);
    return;
  }
  const deleted = await TrialSvc.purgeExpired();
  console.log(`Deleted ${deleted} expired trial guest(s).`);
}

// Exits explicitly: the services it loads open a Redis connection that would keep it running.
main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit();
  });
