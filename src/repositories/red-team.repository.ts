import prisma from "../lib/prisma";
import { Prisma } from "@prisma/client";
import { RedTeamClaim } from "../utils/red-team-claims-parse";

export default class RedTeamRepo {
  static async get(caseId: string) {
    return prisma.redTeamAssessment.findUnique({ where: { caseId } });
  }

  static async upsert(caseId: string, content: string, claims: RedTeamClaim[] | undefined) {
    const claimsJson = claims ? (claims as unknown as Prisma.InputJsonValue) : Prisma.JsonNull;
    return prisma.redTeamAssessment.upsert({
      where: { caseId },
      create: { caseId, content, claims: claimsJson },
      update: { content, claims: claimsJson },
    });
  }
}
