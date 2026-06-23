import prisma from "../lib/prisma";

export default class SignupRepo {
  static async createUser(username: string, email: string, password: string) {
    return prisma.user.create({ data: { username, email, password } });
  }

  static async findByEmail(email: string) {
  return prisma.user.findUnique({ where: { email } });
  }
}
