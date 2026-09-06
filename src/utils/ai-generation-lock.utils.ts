import { Prisma } from "@prisma/client";
import { STALE_AFTER_MS } from "../constants";

export function isJobStale(startedAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - startedAt.getTime() > STALE_AFTER_MS;
}

export function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}
