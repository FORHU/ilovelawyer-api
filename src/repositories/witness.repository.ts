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
  /** Ticked-off "what's needed" items, each with its proof document. Built by WitnessSvc. */
  needsDone?: unknown[];
  contact?: string | null;
  notes?: string | null;
}

export interface WitnessAiExtractInput {
  name: string;
  role: string | null;
  summary: string | null;
  sourceDocumentId: string;
  sourceQuote: string;
}

export interface WitnessAiScoreInput {
  aiCredibility: number | null;
  aiRationale: { text: string; source: string | null }[];
  aiSuggestedStatus: WitnessStatusInput | null;
  /** Rubric audit: per-factor answers plus the computed band, flags and coverage. */
  aiFactors: unknown;
  aiRubricVersion: number;
  scoredAt: Date;
}

export default class WitnessRepo {
  static async list(caseId: string) {
    return prisma.witness.findMany({
      where: { caseId },
      orderBy: { createdAt: "desc" },
      // Name of the document an AI-extracted witness was found in, for the panel's source line.
      include: { sourceDocument: { select: { id: true, name: true } } },
    });
  }

  static async create(caseId: string, data: WitnessInput) {
    const { needsDone, ...rest } = data;
    return prisma.witness.create({
      data: { caseId, ...rest, ...(needsDone ? { needsDone: needsDone as Prisma.InputJsonValue } : {}) },
    });
  }

  static async createFromAi(caseId: string, data: WitnessAiExtractInput) {
    return prisma.witness.create({ data: { caseId, source: "AI", ...data } });
  }

  static async update(id: string, caseId: string, data: Partial<WitnessInput>) {
    const existing = await prisma.witness.findFirst({ where: { id, caseId } });
    if (!existing) return null;
    const { needsDone, ...rest } = data;
    return prisma.witness.update({
      where: { id },
      data: { ...rest, ...(needsDone ? { needsDone: needsDone as Prisma.InputJsonValue } : {}) },
    });
  }

  /** Writes only the ai* columns — never status/credibility/credibilityOverride. */
  static async saveAiScore(id: string, caseId: string, data: WitnessAiScoreInput) {
    return prisma.witness.updateMany({
      where: { id, caseId },
      data: {
        ...data,
        aiRationale: data.aiRationale as unknown as Prisma.InputJsonValue,
        aiFactors: data.aiFactors as Prisma.InputJsonValue,
      },
    });
  }

  /** Writes a recompute after a lawyer's factor override: the derived score fields and the overrides. */
  static async saveRecompute(
    id: string,
    caseId: string,
    data: {
      aiCredibility: number | null;
      aiSuggestedStatus: WitnessStatusInput;
      aiFactors: unknown;
      factorOverrides: unknown;
    },
  ) {
    return prisma.witness.updateMany({
      where: { id, caseId },
      data: {
        aiCredibility: data.aiCredibility,
        aiSuggestedStatus: data.aiSuggestedStatus,
        aiFactors: data.aiFactors as Prisma.InputJsonValue,
        factorOverrides: (data.factorOverrides ?? Prisma.DbNull) as Prisma.InputJsonValue,
      },
    });
  }

  static async delete(id: string, caseId: string) {
    const result = await prisma.witness.deleteMany({ where: { id, caseId } });
    return result.count > 0;
  }
}
