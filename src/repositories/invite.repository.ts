import prisma from "../lib/prisma";

export default class InviteRepo {
  static async create(consultationId: string, createdBy: string, expiresAt: Date) {
    return prisma.consultationInvite.create({
      data: { consultationId, createdBy, expiresAt },
    });
  }

  static async findById(id: string) {
    return prisma.consultationInvite.findUnique({
      where: { id },
      include: { consultation: true, creator: { select: { id: true, name: true, email: true } } },
    });
  }

  static async listByConsultation(consultationId: string) {
    return prisma.consultationInvite.findMany({
      where: { consultationId },
      orderBy: { createdAt: "desc" },
    });
  }

  static async delete(id: string) {
    return prisma.consultationInvite.delete({ where: { id } });
  }
}
