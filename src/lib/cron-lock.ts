import prisma from "./prisma";
import logger from "../utils/logger";

/** Longest a locked run may take before Prisma rolls the holding transaction back (which also
 * releases the lock). The deletion sweeps are paged and finish well inside this. */
const MAX_RUN_MS = 30 * 60 * 1000;

/** Stable 32-bit key for `name`, so every API instance asks Postgres for the same lock. */
function lockKey(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (Math.imul(hash, 31) + name.charCodeAt(i)) | 0;
  return hash;
}

/**
 * Runs `fn` on at most one API instance at a time. node-cron fires on every instance, so without
 * this each one would run the same sweep (and, for account deletion, send the same email twice).
 * A transaction-scoped advisory lock is held on one pooled connection for the length of the run
 * and released when that transaction ends — a session-scoped lock could be taken and released on
 * different pooled connections. An instance that doesn't get the lock skips this run.
 */
export async function withCronLock(name: string, fn: () => Promise<void>): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${lockKey(name)}) AS locked`;
      if (!locked) {
        logger.info("Cron job already running on another instance; skipping this run", { job: name });
        return;
      }
      await fn();
    },
    { timeout: MAX_RUN_MS, maxWait: 10_000 },
  );
}
