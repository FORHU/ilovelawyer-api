import prisma from "../lib/prisma";

export default class LoginRepo {
  static async findByEmail(email: string) {
    return prisma.user.findUnique({ where: { email } });
  }

  static async createSession(userId: string, refreshToken: string, expiresAt: Date) {
    return prisma.session.create({ data: { userId, refreshToken, expiresAt } });
  }

  static async updateLastLogin(userId: string) {
    return prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
  }
}
