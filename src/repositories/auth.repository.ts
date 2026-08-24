import prisma from "../lib/prisma";

export default class AuthRepo {
  static async createUser(data: { username: string; email: string; password: string; name: string }) {
    return prisma.user.create({
      data: { username: data.username, email: data.email, password: data.password, name: data.name },
    });
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

  static async deleteUser(userId: string) {
    return prisma.user.delete({ where: { id: userId } });
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

  static async setEmailVerificationOtp(userId: string, code: string, expiresAt: Date) {
    return prisma.user.update({
      where: { id: userId },
      data: { emailVerificationOtp: code, emailVerificationOtpExpiry: expiresAt },
    });
  }

  static async consumeEmailVerificationOtp(email: string, code: string) {
    const user = await prisma.user.findFirst({
      where: { email, emailVerificationOtp: code, emailVerificationOtpExpiry: { gt: new Date() } },
    });
    if (!user) return null;

    // Re-evaluated atomically by Postgres at update time, same race-safety as consumeResetToken.
    const result = await prisma.user.updateMany({
      where: { id: user.id, emailVerificationOtp: code, emailVerificationOtpExpiry: { gt: new Date() } },
      data: { isEmailVerified: true, emailVerificationOtp: null, emailVerificationOtpExpiry: null },
    });

    return result.count > 0 ? user : null;
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
      // Completing a reset via the emailed link is proof of ownership of that inbox,
      // so it also satisfies email verification — otherwise an unverified account that
      // resets its password would still be locked out of login by the isEmailVerified
      // check right after successfully resetting.
      data: { password: hashedPassword, otpCode: null, otpExpiry: null, isEmailVerified: true },
    });

    return result.count > 0 ? user.id : null;
  }

  static async setEmailVerificationCode(userId: string, code: string, expiresAt: Date) {
    return prisma.user.update({
      where: { id: userId },
      data: {
        emailVerificationCode: code,
        emailVerificationExpiry: expiresAt,
        emailVerificationAttempts: 0,
        emailVerificationLastSentAt: new Date(),
      },
    });
  }

  static async incrementEmailVerificationAttempts(userId: string): Promise<number> {
    const user = await prisma.user.update({
      where: { id: userId },
      data: { emailVerificationAttempts: { increment: 1 } },
      select: { emailVerificationAttempts: true },
    });
    return user.emailVerificationAttempts;
  }

  static async invalidateEmailVerificationCode(userId: string) {
    return prisma.user.update({
      where: { id: userId },
      data: { emailVerificationCode: null, emailVerificationExpiry: null },
    });
  }

  static async markEmailVerified(userId: string) {
    return prisma.user.update({
      where: { id: userId },
      data: {
        isEmailVerified: true,
        emailVerificationCode: null,
        emailVerificationExpiry: null,
        emailVerificationAttempts: 0,
      },
    });
  }
}
