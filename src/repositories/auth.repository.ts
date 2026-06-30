import prisma from "../lib/prisma";

export default class AuthRepo {
  static async createUser(username: string, email: string, password: string) {
    return prisma.user.create({ data: { username, email, password } });
  }

  static async findByEmail(email: string) {
    return prisma.user.findUnique({ where: { email } });
  }

  static async findById(id: string) {
    return prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        username: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        isEmailVerified: true,
        onboardingCompleted: true,
        provider: true,
        avatarId: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
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

  static async findByGoogleId(googleId: string) {
    return prisma.user.findUnique({ where: { googleId } });
  }

  static async createGoogleUser(email: string, googleId: string, name?: string) {
    const base = email.split("@")[0].replace(/[^a-zA-Z0-9_]/g, "").slice(0, 20) || "user";
    let username = base;
    while (await prisma.user.findUnique({ where: { username } })) {
      username = `${base}${Math.floor(Math.random() * 9000) + 1000}`;
    }

    return prisma.user.create({
      data: {
        username,
        email,
        googleId,
        name,
        provider: "google",
        isEmailVerified: true,
        lastLoginAt: new Date(),
      },
    });
  }

  static async setResetToken(userId: string, token: string, expiresAt: Date) {
    return prisma.user.update({ where: { id: userId }, data: { otpCode: token, otpExpiry: expiresAt } });
  }

  static async findByResetToken(token: string) {
    return prisma.user.findFirst({ where: { otpCode: token, otpExpiry: { gt: new Date() } } });
  }

  static async resetPassword(userId: string, hashedPassword: string) {
    return prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword, otpCode: null, otpExpiry: null },
    });
  }
}
