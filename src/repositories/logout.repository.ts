import prisma from "../lib/prisma";

export default class LogoutRepo {
  static async deleteByRefreshToken(refreshToken: string) {
    return prisma.session.deleteMany({ where: { refreshToken } });
  }
}
