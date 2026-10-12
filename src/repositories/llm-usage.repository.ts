import { Prisma } from "@prisma/client";
import prisma from "../lib/prisma";

export default class LlmUsageRepo {
  static async create(data: Prisma.LlmUsageUncheckedCreateInput) {
    return prisma.llmUsage.create({ data });
  }
}
