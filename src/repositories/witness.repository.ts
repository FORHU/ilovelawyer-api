import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";

export type WitnessStatusInput = "READY" | "ADVERSE" | "OUTSTANDING";

export interface WitnessInput {
  name: string;
  role?: string | null;
  summary?: string | null;
  status?: WitnessStatusInput;
  credibility?: number;
  /** Lawyer's manual score. Null clears it, so the AI score shows again. */
  credibilityOverride?: number | null;
  statementDueOn?: Date | null;
  statementReceived?: boolean;
  contact?: string | null;
  notes?: string | null;
}

export interface WitnessAiScoreInput {
  aiCredibility: number | null;
  aiRationale: { text: string; source: string | null }[];
  aiSuggestedStatus: WitnessStatusInput | null;
  scoredAt: Date;
}

export default class WitnessRepo {
  static async list(caseId: string) {
    return prisma.witness.findMany({ where: { caseId }, orderBy: { createdAt: "desc" } });
  }

  static async create(caseId: string, data: WitnessInput) {
    return prisma.witness.create({ data: { caseId, ...data } });
  }

  static async update(id: string, caseId: string, data: Partial<WitnessInput>) {
    const existing = await prisma.witness.findFirst({ where: { id, caseId } });
    if (!existing) return null;
    return prisma.witness.update({ where: { id }, data });
  }

  /** Writes only the ai* columns — never status/credibility/credibilityOverride. */
  static async saveAiScore(id: string, caseId: string, data: WitnessAiScoreInput) {
    return prisma.witness.updateMany({
      where: { id, caseId },
      data: { ...data, aiRationale: data.aiRationale as unknown as Prisma.InputJsonValue },
    });
  }

  static async delete(id: string, caseId: string) {
    const result = await prisma.witness.deleteMany({ where: { id, caseId } });
    return result.count > 0;
  }
}
