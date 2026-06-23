import prisma from "../lib/prisma";

export default class RefreshRepo {
  static async findByRefreshToken(refreshToken: string) {
    return prisma.session.findUnique({ where: { refreshToken } });
  }

  static async deleteByRefreshToken(refreshToken: string) {
    return prisma.session.delete({ where: { refreshToken } });
  }

  static async createSession(userId: string, refreshToken: string, expiresAt: Date) {
    return prisma.session.create({ data: { userId, refreshToken, expiresAt } });
  }
}
