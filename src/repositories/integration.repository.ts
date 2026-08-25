import prisma from "../lib/prisma";
import { ConnectorStatus, ConnectorType, Prisma } from "@prisma/client";

export default class IntegrationRepo {
  static async list(userId: string, organizationId?: string) {
    return prisma.integrationConnector.findMany({
      where: {
        OR: [{ userId }, ...(organizationId ? [{ organizationId }] : [])],
      },
      orderBy: { createdAt: "desc" },
    });
  }

  static async create(data: {
    userId?: string | null;
    organizationId?: string | null;
    type: ConnectorType;
    status?: ConnectorStatus;
    configJson?: Prisma.InputJsonValue;
  }) {
    return prisma.integrationConnector.create({ data });
  }

  static async updateStatus(id: string, userId: string, status: ConnectorStatus, configJson?: Prisma.InputJsonValue) {
    const existing = await prisma.integrationConnector.findFirst({
      where: { id, OR: [{ userId }, { organization: { members: { some: { userId } } } }] },
    });
    if (!existing) return null;
    return prisma.integrationConnector.update({
      where: { id },
      data: { status, ...(configJson !== undefined ? { configJson } : {}) },
    });
  }
}
