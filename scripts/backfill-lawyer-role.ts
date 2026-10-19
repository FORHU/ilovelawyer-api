/**
 * One-time script: move every USER account to LAWYER. ADMIN rows are never touched. Dry run unless
 * --apply; re-running after a successful apply changes nothing.
 *
 * Only safe while every USER row is a lawyer from before the role split, i.e. before the client
 * app has signed anyone up against this database. After that, USER means a real client-app
 * account (see src/utils/client-app.ts) and this script would turn clients into lawyers.
 *
 * Run:
 *   npx ts-node scripts/backfill-lawyer-role.ts                                     (dry run)
 *   npx ts-node scripts/backfill-lawyer-role.ts --apply --confirm <db-host>
 *   npx ts-node scripts/backfill-lawyer-role.ts --revert <backup file> --confirm <db-host>
 *
 * <db-host> is the host:port the dry run prints — a guard against writing to the wrong database.
 * --apply saves the ids it changes to backups/ first; --revert sets exactly those back to USER.
 */
import * as dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import prisma from "../src/lib/prisma";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const dbHost = new URL(process.env.DATABASE_URL!).host;

async function counts() {
  const rows = await prisma.user.groupBy({ by: ["role"], _count: { _all: true } });
  return Object.fromEntries(rows.map((r) => [r.role, r._count._all]));
}

function assertConfirmed() {
  if (value("--confirm") !== dbHost) throw new Error(`Pass --confirm ${dbHost} to write to this database`);
}

async function revert(file: string) {
  assertConfirmed();
  const backup: { dbHost: string; ids: string[] } = JSON.parse(fs.readFileSync(file, "utf8"));
  if (backup.dbHost !== dbHost) throw new Error(`${file} was taken from ${backup.dbHost}, not ${dbHost}`);

  const { count } = await prisma.user.updateMany({
    where: { id: { in: backup.ids }, role: "LAWYER" },
    data: { role: "USER" },
  });
  console.log(`Reverted ${count} of ${backup.ids.length}.`);
}

async function apply(ids: string[]) {
  assertConfirmed();
  const file = path.join("backups", `role-backfill-${Date.now()}.json`);
  fs.mkdirSync("backups", { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ dbHost, at: new Date().toISOString(), ids }, null, 2));
  console.log(`Saved ${ids.length} ids to ${file}`);

  // Updates the ids just saved, not "role = USER" again, so the backup is exactly what changed.
  const count = await prisma.$transaction(async (tx) => {
    const { count } = await tx.user.updateMany({ where: { id: { in: ids }, role: "USER" }, data: { role: "LAWYER" } });
    if (count !== ids.length) throw new Error(`Expected ${ids.length}, updated ${count} — rolled back`);
    return count;
  });
  console.log(`Updated ${count}.`);
}

async function main() {
  console.log(`Database: ${dbHost}`);
  console.log("Before:", await counts());

  const revertFile = value("--revert");
  if (revertFile) {
    await revert(revertFile);
    console.log("After:", await counts());
    return;
  }

  const targets = await prisma.user.findMany({
    where: { role: "USER" },
    select: { id: true, email: true, approvalStatus: true, trialExpiresAt: true },
    orderBy: { createdAt: "asc" },
  });
  const trial = targets.filter((u) => u.trialExpiresAt).length;
  console.log(`Would change ${targets.length} USER -> LAWYER (real ${targets.length - trial}, trial ${trial})`);
  for (const u of targets.slice(0, 10)) console.log(`  ${u.email} [${u.approvalStatus}]`);

  if (!flag("--apply")) {
    console.log(`\nDry run — nothing written. To apply: --apply --confirm ${dbHost}`);
    return;
  }
  if (targets.length === 0) {
    console.log("Nothing to change.");
    return;
  }

  await apply(targets.map((u) => u.id));
  console.log("After:", await counts());
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
