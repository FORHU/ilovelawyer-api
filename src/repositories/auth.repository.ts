import prisma from "../lib/prisma";

export default class AuthRepo {
  static async createUser(username: string, email: string, password: string) {
    return prisma.user.create({ data: { username, email, password } });
  }

  static async findByEmail(email: string) {
    return prisma.user.findUnique({ where: { email } });
  }

  static async updateLastLogin(userId: string) {
    return prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
  }

  static async findByRefreshToken(refreshToken: string) {
    return prisma.session.findUnique({ where: { refreshToken } });
  }

  static async createSession(userId: string, refreshToken: string, expiresAt: Date) {
    return prisma.session.create({ data: { userId, refreshToken, expiresAt } });
  }

  static async deleteByRefreshToken(refreshToken: string) {
    return prisma.session.deleteMany({ where: { refreshToken } });
  }
}
