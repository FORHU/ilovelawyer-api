import prisma from "../lib/prisma";
import { Prisma, RoutingMode } from "@prisma/client";

export default class PersonaRoutingOverrideRepo {
  static async listAll() {
    return prisma.personaRoutingOverride.findMany({ orderBy: { persona: "asc" } });
  }

  static async find(persona: string) {
    return prisma.personaRoutingOverride.findUnique({ where: { persona } });
  }

  /** Upsert: a persona's first override creates its row, a later one just updates it — there's
   * no separate "create" step for an admin to remember. */
  static async upsert(
    persona: string,
    data: { routingMode: RoutingMode; manualPinnedModel: string | null; toolOverrides: Prisma.InputJsonValue | null },
    updatedById: string | null,
  ) {
    const toolOverrides = data.toolOverrides === null ? Prisma.JsonNull : data.toolOverrides;
    return prisma.personaRoutingOverride.upsert({
      where: { persona },
      create: { persona, routingMode: data.routingMode, manualPinnedModel: data.manualPinnedModel, toolOverrides, updatedById },
      update: { routingMode: data.routingMode, manualPinnedModel: data.manualPinnedModel, toolOverrides, updatedById },
    });
  }
}
