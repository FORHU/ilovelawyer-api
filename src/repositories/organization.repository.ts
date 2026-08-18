import prisma from "../lib/prisma";
import { OrganizationRole } from "@prisma/client";

export default class OrganizationRepo {
  /** Creates the org and its first membership (creator as OWNER) atomically. */
  static async createWithOwner(userId: string, data: { name: string; slug: string }) {
    return prisma.organization.create({
      data: {
        ...data,
        members: { create: { userId, role: OrganizationRole.OWNER } },
      },
      include: { members: true },
    });
  }

  static async findBySlug(slug: string) {
    return prisma.organization.findUnique({ where: { slug } });
  }

  static async findById(id: string) {
    return prisma.organization.findUnique({ where: { id } });
  }

  /** Orgs the given user belongs to, with their role in each. */
  static async listForUser(userId: string) {
    return prisma.organization.findMany({
      where: { members: { some: { userId } } },
      orderBy: { createdAt: "asc" },
      include: { members: { where: { userId }, select: { role: true } } },
    });
  }

  static async update(id: string, data: { name?: string; slug?: string }) {
    return prisma.organization.update({ where: { id }, data });
  }
}
