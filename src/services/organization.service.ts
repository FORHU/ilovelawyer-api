import { CasePermission, OrganizationRole, OrganizationMemberStatus, PackageSku } from "@prisma/client";
import OrganizationRepo from "../repositories/organization.repository";
import OrganizationMemberRepo from "../repositories/organization-member.repository";
import AuthRepo from "../repositories/auth.repository";
import CaseAccess from "../utils/case-access";
import HttpError from "../utils/http-error";
import { hasOrgRole } from "../utils/org-role";
import { sendEmail } from "../utils/mailer";
import { renderTemplate } from "../utils/template";
import { slugify } from "../utils/slug";
import { CLIENT_URL } from "../config";

export default class OrganizationSvc {
  static async create(userId: string, name: string, packageSku?: PackageSku) {
    const slug = await OrganizationSvc.generateUniqueSlug(name);
    return OrganizationRepo.create(userId, name, slug, packageSku ?? "PROFESSIONAL");
  }

  private static async generateUniqueSlug(name: string): Promise<string> {
    const base = slugify(name);
    let slug = base;
    while (await OrganizationRepo.findBySlug(slug)) {
      slug = `${base}-${Math.floor(1000 + Math.random() * 9000)}`;
    }
    return slug;
  }

  /** Orgs the given user is an ACCEPTED member of, with their role in each. A PENDING
   * invite doesn't count as belonging yet — see OrganizationMemberRepo.findPendingForUser. */
  static async listForUser(userId: string) {
    const orgs = await OrganizationRepo.listForUser(userId);
    // Each org was fetched with `members` pre-filtered to this user and ACCEPTED status
    // (see repo), so it's always exactly one row — flatten it into a plain `role` field.
    // A PENDING invite deliberately doesn't show up here; see getPendingInviteForUser.
    return orgs.map(({ members, ...org }) => ({ ...org, role: members[0]?.role }));
  }

  static async getById(id: string, userId: string) {
    const org = await OrganizationRepo.findByIdForUser(id, userId);
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

  /** Resolves the caller's membership/role in an org, or throws 403 if they're not a member.
   * A PENDING invite doesn't count — the invitee has no access until they accept it. */
  static async requireMembership(organizationId: string, userId: string) {
    const membership = await OrganizationMemberRepo.find(organizationId, userId);
    if (!membership) throw new HttpError("Not a member of this organization", 403);
    if (membership.status === OrganizationMemberStatus.PENDING) {
      throw new HttpError("Your invite to this organization is still pending", 403);
    }
    return membership;
  }

  /** Invites an existing user by email. The invitee lands as PENDING until they accept —
   * only an OWNER can grant the OWNER role. */
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
    if (existing) {
      const message =
        existing.status === OrganizationMemberStatus.PENDING
          ? "User already has a pending invite to this organization"
          : "User is already a member of this organization";
      throw new HttpError(message, 409);
    }

    const elsewhere = await OrganizationMemberRepo.findAnyForUser(user.id);
    if (elsewhere) {
      throw new HttpError(
        "This user already belongs to (or has a pending invite from) another organization. They must leave/decline it before joining a new one.",
        409,
      );
    }

    const member = await OrganizationMemberRepo.add(organizationId, user.id, role, OrganizationMemberStatus.PENDING);

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
    await sendEmail({ to: email, subject: `You've been invited to join ${organization?.name}`, html });

    return member;
  }

  /** The caller's own pending invite, if any (a user can have at most one, org-wide). */
  static async getPendingInviteForUser(userId: string) {
    return OrganizationMemberRepo.findPendingForUser(userId);
  }

  static async acceptInvite(organizationId: string, userId: string) {
    const membership = await OrganizationMemberRepo.find(organizationId, userId);
    if (!membership || membership.status !== OrganizationMemberStatus.PENDING) {
      throw new HttpError("No pending invite found for this organization", 404);
    }
    return OrganizationMemberRepo.updateStatus(userId, OrganizationMemberStatus.ACCEPTED);
  }

  static async declineInvite(organizationId: string, userId: string) {
    const membership = await OrganizationMemberRepo.find(organizationId, userId);
    if (!membership || membership.status !== OrganizationMemberStatus.PENDING) {
      throw new HttpError("No pending invite found for this organization", 404);
    }
    await OrganizationMemberRepo.remove(organizationId, userId);
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

  /** Removes a member. Only an OWNER may remove an ADMIN or another OWNER (an ADMIN may
   * only remove MANAGER/MEMBER); self-removal must go through leave() instead. */
  static async removeMember(organizationId: string, actingRole: OrganizationRole, actingUserId: string, targetUserId: string) {
    if (actingUserId === targetUserId) {
      throw new HttpError("Use the leave organization action to remove yourself", 400);
    }

    const target = await OrganizationMemberRepo.find(organizationId, targetUserId);
    if (!target) throw new HttpError("Member not found", 404);

    if (hasOrgRole(target.role, OrganizationRole.ADMIN) && !hasOrgRole(actingRole, OrganizationRole.OWNER)) {
      throw new HttpError("Only an owner can remove an admin or owner", 403);
    }

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

  // ── Case access / audit (per-case sharing within an org, independent of org role — gated
  // by CaseAccess.assertCanEdit, same authorization the case's own routes use) ──────────────

  /** Links an existing Case to this Organization. Requires edit access to the case itself
   * (ownership, a granted CaseAccess row, or OWNER/ADMIN membership in the case's *current*
   * org, if any) — not membership in the org being attached to. */
  static async attachCase(organizationId: string, caseId: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const org = await OrganizationRepo.findByIdForUser(organizationId, userId);
    if (!org) throw new HttpError("Organization not found", 404);
    const updated = await OrganizationRepo.attachCase(caseId, organizationId);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "org.attach_case", payload: { organizationId } });
    return updated;
  }

  static async grantAccess(caseId: string, actorId: string, userId: string, permission: CasePermission) {
    await CaseAccess.assertCanEdit(caseId, actorId);
    const access = await OrganizationRepo.grantCaseAccess(caseId, userId, permission);
    await OrganizationRepo.writeAudit({ caseId, actorId, action: "case.grant_access", payload: { userId, permission } });
    return access;
  }

  static async teamAudit(caseId: string, userId: string) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    const [accesses, audit] = await Promise.all([
      OrganizationRepo.listCaseAccess(caseId),
      OrganizationRepo.listAudit(caseId),
    ]);
    return { accesses, audit };
  }
}
