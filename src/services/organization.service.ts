import { OrganizationRole } from "@prisma/client";
import OrganizationRepo from "../repositories/organization.repository";
import OrganizationMemberRepo from "../repositories/organization-member.repository";
import AuthRepo from "../repositories/auth.repository";
import HttpError from "../utils/http-error";
import { hasOrgRole } from "../utils/org-role";
import { sendEmail } from "../utils/mailer";
import { renderTemplate } from "../utils/template";
import { CLIENT_URL } from "../config";

export default class OrganizationSvc {
  static async create(userId: string, data: { name: string; slug: string }) {
    const existing = await OrganizationRepo.findBySlug(data.slug);
    if (existing) throw new HttpError("An organization with this slug already exists", 409);

    return OrganizationRepo.createWithOwner(userId, data);
  }

  static async listForUser(userId: string) {
    const orgs = await OrganizationRepo.listForUser(userId);
    // Each org was fetched with `members` pre-filtered to this user (see repo), so it's
    // always exactly one row — flatten it into a plain `role` field for the response.
    return orgs.map(({ members, ...org }) => ({ ...org, role: members[0]?.role }));
  }

  static async getById(id: string) {
    const org = await OrganizationRepo.findById(id);
    if (!org) throw new HttpError("Organization not found", 404);
    return org;
  }

  static async update(id: string, data: { name?: string; slug?: string }) {
    if (data.slug) {
      const existing = await OrganizationRepo.findBySlug(data.slug);
      if (existing && existing.id !== id) throw new HttpError("An organization with this slug already exists", 409);
    }
    return OrganizationRepo.update(id, data);
  }

  static async listMembers(organizationId: string) {
    return OrganizationMemberRepo.list(organizationId);
  }

  /** Resolves the caller's membership/role in an org, or throws 403 if they're not a member. */
  static async requireMembership(organizationId: string, userId: string) {
    const membership = await OrganizationMemberRepo.find(organizationId, userId);
    if (!membership) throw new HttpError("Not a member of this organization", 403);
    return membership;
  }

  /** Invites an existing user by email. Only an OWNER can grant the OWNER role. */
  static async inviteMember(
    organizationId: string,
    actingRole: OrganizationRole,
    actingUserId: string,
    email: string,
    role: OrganizationRole,
  ) {
    if (role === OrganizationRole.OWNER && !hasOrgRole(actingRole, OrganizationRole.OWNER)) {
      throw new HttpError("Only an owner can grant the owner role", 403);
    }

    const user = await AuthRepo.findByEmail(email);
    if (!user) throw new HttpError("No user found with this email", 404);

    const existing = await OrganizationMemberRepo.find(organizationId, user.id);
    if (existing) throw new HttpError("User is already a member of this organization", 409);

    const elsewhere = await OrganizationMemberRepo.findAnyForUser(user.id);
    if (elsewhere) {
      throw new HttpError(
        "This user already belongs to another organization. They must leave it before joining a new one.",
        409,
      );
    }

    const member = await OrganizationMemberRepo.add(organizationId, user.id, role);

    const [organization, inviter] = await Promise.all([
      OrganizationRepo.findById(organizationId),
      AuthRepo.findById(actingUserId),
    ]);
    const html = await renderTemplate("org-invite", {
      inviterName: inviter?.name || "A team member",
      orgName: organization?.name ?? "",
      role,
      loginLink: `${CLIENT_URL[0]}/login`,
    });
    await sendEmail({ to: email, subject: `You've been added to ${organization?.name}`, html });

    return member;
  }

  /** Changes a member's role. Guards against granting OWNER without being one, and against demoting the last OWNER. */
  static async changeMemberRole(organizationId: string, actingRole: OrganizationRole, targetUserId: string, role: OrganizationRole) {
    const target = await OrganizationMemberRepo.find(organizationId, targetUserId);
    if (!target) throw new HttpError("Member not found", 404);

    if (role === OrganizationRole.OWNER && !hasOrgRole(actingRole, OrganizationRole.OWNER)) {
      throw new HttpError("Only an owner can grant the owner role", 403);
    }

    if (target.role === OrganizationRole.OWNER && role !== OrganizationRole.OWNER) {
      await this.assertNotLastOwner(organizationId);
    }

    return OrganizationMemberRepo.updateRole(organizationId, targetUserId, role);
  }

  static async removeMember(organizationId: string, targetUserId: string) {
    const target = await OrganizationMemberRepo.find(organizationId, targetUserId);
    if (!target) throw new HttpError("Member not found", 404);

    if (target.role === OrganizationRole.OWNER) {
      await this.assertNotLastOwner(organizationId);
    }

    await OrganizationMemberRepo.remove(organizationId, targetUserId);
  }

  /** Self-service: a member removes their own membership. A sole-member OWNER may leave
   * freely (the Organization row is preserved, just ownerless — never cascade-deleted by
   * this action). An OWNER who isn't the sole member can only leave once another OWNER
   * exists (this app allows multiple OWNERs per org, same as changeMemberRole/removeMember
   * — see assertNotLastOwner) — otherwise they must promote a teammate to OWNER first. */
  static async leave(organizationId: string, userId: string) {
    const membership = await OrganizationMemberRepo.find(organizationId, userId);
    if (!membership) throw new HttpError("Not a member of this organization", 404);

    if (membership.role === OrganizationRole.OWNER) {
      const members = await OrganizationMemberRepo.list(organizationId);
      if (members.length > 1) {
        await this.assertNotLastOwner(organizationId);
      }
    }

    await OrganizationMemberRepo.remove(organizationId, userId);
  }

  /** Throws if the org currently has exactly one OWNER — the caller is about to remove/demote them. */
  private static async assertNotLastOwner(organizationId: string) {
    const ownerCount = await OrganizationMemberRepo.countByRole(organizationId, OrganizationRole.OWNER);
    if (ownerCount <= 1) throw new HttpError("Cannot remove the organization's last owner", 400);
  }
}
