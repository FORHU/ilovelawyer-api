import { Prisma } from "@prisma/client";
import { HEARTBEAT_STALE_AFTER_MS, STALE_AFTER_MS } from "../constants";

/** Whether an IN_PROGRESS job was abandoned. Once its work has started, only a silent heartbeat
 * counts; before that (still queued), its age since startedAt. */
export function isJobStale(job: { startedAt: Date; heartbeatAt?: Date | null }, now: Date = new Date()): boolean {
  if (job.heartbeatAt) return now.getTime() - job.heartbeatAt.getTime() > HEARTBEAT_STALE_AFTER_MS;
  return now.getTime() - job.startedAt.getTime() > STALE_AFTER_MS;
}

export function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}
