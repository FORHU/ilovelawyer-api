import prisma from "../lib/prisma";
import { Prisma } from "@prisma/client";

/** Canonicalizes an unordered pair so a lookup works regardless of argument order — the pair
 * (b, a) and (a, b) are always stored/read as the same row. */
function canonicalPair(theoryAId: string, theoryBId: string): [string, string] {
  return theoryAId < theoryBId ? [theoryAId, theoryBId] : [theoryBId, theoryAId];
}

export default class TheoryDiffRepo {
  static async get(theoryAId: string, theoryBId: string) {
    const [a, b] = canonicalPair(theoryAId, theoryBId);
    return prisma.theoryDiff.findUnique({ where: { theoryAId_theoryBId: { theoryAId: a, theoryBId: b } } });
  }

  static async upsert(caseId: string, theoryAId: string, theoryBId: string, result: unknown) {
    const [a, b] = canonicalPair(theoryAId, theoryBId);
    return prisma.theoryDiff.upsert({
      where: { theoryAId_theoryBId: { theoryAId: a, theoryBId: b } },
      create: { caseId, theoryAId: a, theoryBId: b, result: result as Prisma.InputJsonValue },
      update: { result: result as Prisma.InputJsonValue },
    });
  }
}
