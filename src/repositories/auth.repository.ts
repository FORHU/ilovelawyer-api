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

  static async findByUsername(username: string) {
    return prisma.user.findUnique({ where: { username } });
  }

  static async updateProfile(userId: string, data: { name?: string; username?: string }) {
    return prisma.user.update({
      where: { id: userId },
      data,
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

  static async findByRefreshToken(refreshToken: string) {
    return prisma.session.findUnique({ where: { refreshToken } });
  }

  static async createSession(userId: string, refreshToken: string, expiresAt: Date) {
    return prisma.session.create({ data: { userId, refreshToken, expiresAt } });
  }

  static async deleteByRefreshToken(refreshToken: string) {
    return prisma.session.deleteMany({ where: { refreshToken } });
  }

  static async deleteSessionsByUserId(userId: string) {
    return prisma.session.deleteMany({ where: { userId } });
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

  static async findGoogleRefreshToken(userId: string): Promise<string | null> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { googleRefreshToken: true } });
    return user?.googleRefreshToken ?? null;
  }

  static async updateGoogleAccessToken(userId: string, accessToken: string) {
    return prisma.user.update({ where: { id: userId }, data: { googleAccessToken: accessToken } });
  }

  static async setResetToken(userId: string, token: string, expiresAt: Date) {
    return prisma.user.update({ where: { id: userId }, data: { otpCode: token, otpExpiry: expiresAt } });
  }

  static async isResetTokenValid(token: string): Promise<boolean> {
    const user = await prisma.user.findFirst({
      where: { otpCode: token, otpExpiry: { gt: new Date() } },
      select: { id: true },
    });
    return !!user;
  }

  static async consumeResetToken(token: string, hashedPassword: string): Promise<string | null> {
    const user = await prisma.user.findFirst({
      where: { otpCode: token, otpExpiry: { gt: new Date() } },
      select: { id: true },
    });
    if (!user) return null;

    // The WHERE clause here is re-evaluated atomically by Postgres at update time,
    // not at the time of the findFirst above — so concurrent requests racing on the
    // same token still only let one of them actually match and consume it.
    const result = await prisma.user.updateMany({
      where: { id: user.id, otpCode: token, otpExpiry: { gt: new Date() } },
      data: { password: hashedPassword, otpCode: null, otpExpiry: null },
    });

    return result.count > 0 ? user.id : null;
  }
}
