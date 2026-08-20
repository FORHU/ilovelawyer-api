import prisma from "../lib/prisma";
import { Prisma } from "@prisma/client";

export default class JurisdictionModuleRepo {
  static async list() {
    return prisma.jurisdictionModule.findMany({ orderBy: { code: "asc" } });
  }

  static async upsert(data: {
    code: string;
    name: string;
    enabled?: boolean;
    language?: string;
    configJson?: Prisma.InputJsonValue;
  }) {
    return prisma.jurisdictionModule.upsert({
      where: { code: data.code },
      create: data,
      update: { name: data.name, enabled: data.enabled, language: data.language, configJson: data.configJson },
    });
  }

  static async setEnabled(code: string, enabled: boolean) {
    const existing = await prisma.jurisdictionModule.findUnique({ where: { code } });
    if (!existing) return null;
    return prisma.jurisdictionModule.update({ where: { code }, data: { enabled } });
  }
}
