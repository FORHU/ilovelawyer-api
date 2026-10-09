import prisma from "../lib/prisma";
import { OrganizationRole, OrganizationStatus } from "@prisma/client";

/** Invites to email addresses with no account yet — see OrganizationEmailInvite in schema.prisma.
 * `email` is always normalized (normalizeEmail) by the caller, the same as User.email. */
export default class OrganizationEmailInviteRepo {
  /** Carries the organization's status: an invite to one that's being deleted is dead (see
   * OrganizationSvc.inviteByEmail). */
  static async findByEmail(email: string) {
    return prisma.organizationEmailInvite.findUnique({
      where: { email },
      include: { organization: { select: { status: true } } },
    });
  }

  /** Whether the address holds an invite that can still be accepted. */
  static async hasLiveInvite(email: string) {
    const invite = await prisma.organizationEmailInvite.findFirst({
      where: { email, organization: { status: OrganizationStatus.ACTIVE } },
      select: { id: true },
    });
    return !!invite;
  }

  static async delete(id: string) {
    return prisma.organizationEmailInvite.delete({ where: { id } });
  }

  static async list(organizationId: string) {
    return prisma.organizationEmailInvite.findMany({ where: { organizationId }, orderBy: { createdAt: "asc" } });
  }

  static async create(organizationId: string, email: string, role: OrganizationRole) {
    return prisma.organizationEmailInvite.create({ data: { organizationId, email, role } });
  }

  /** Turns the email's invite, if any, into an ordinary OrganizationInvite for the user who now
   * owns that address. A user already holding an invite keeps it (one at a time) and the email
   * invite is just dropped. An invite to an organization that's being deleted (its last member
   * left) counts as none and is dropped too. Returns whether the user ends up with an outstanding
   * invite — the signal AuthSvc.autoApproveIfEnabled approves the account on. */
  static async claim(userId: string, email: string): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const isLive = (invite: { organization: { status: OrganizationStatus } } | null) =>
        invite?.organization.status === OrganizationStatus.ACTIVE;
      const organization = { select: { status: true } } as const;
      let existing = await tx.organizationInvite.findUnique({ where: { userId }, include: { organization } });
      if (existing && !isLive(existing)) {
        await tx.organizationInvite.delete({ where: { userId } });
        existing = null;
      }
      const emailInvite = await tx.organizationEmailInvite.findUnique({ where: { email }, include: { organization } });
      if (!emailInvite) return !!existing;

      await tx.organizationEmailInvite.delete({ where: { id: emailInvite.id } });
      if (existing) return true;
      if (!isLive(emailInvite)) return false;
      await tx.organizationInvite.create({
        data: { organizationId: emailInvite.organizationId, userId, role: emailInvite.role },
      });
      return true;
    });
  }
}
