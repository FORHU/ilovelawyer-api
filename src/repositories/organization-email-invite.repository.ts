import prisma from "../lib/prisma";
import { OrganizationRole } from "@prisma/client";

/** Invites to email addresses with no account yet — see OrganizationEmailInvite in schema.prisma.
 * `email` is always normalized (normalizeEmail) by the caller, the same as User.email. */
export default class OrganizationEmailInviteRepo {
  static async findByEmail(email: string) {
    return prisma.organizationEmailInvite.findUnique({ where: { email } });
  }

  static async list(organizationId: string) {
    return prisma.organizationEmailInvite.findMany({ where: { organizationId }, orderBy: { createdAt: "asc" } });
  }

  static async create(organizationId: string, email: string, role: OrganizationRole) {
    return prisma.organizationEmailInvite.create({ data: { organizationId, email, role } });
  }

  /** Turns the email's invite, if any, into an ordinary OrganizationInvite for the user who now
   * owns that address. A user already holding an invite keeps it (one at a time) and the email
   * invite is just dropped. Returns whether the user ends up with an outstanding invite. */
  static async claim(userId: string, email: string): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const existing = await tx.organizationInvite.findUnique({ where: { userId } });
      const emailInvite = await tx.organizationEmailInvite.findUnique({ where: { email } });
      if (!emailInvite) return !!existing;

      await tx.organizationEmailInvite.delete({ where: { id: emailInvite.id } });
      if (existing) return true;
      await tx.organizationInvite.create({
        data: { organizationId: emailInvite.organizationId, userId, role: emailInvite.role },
      });
      return true;
    });
  }
}
