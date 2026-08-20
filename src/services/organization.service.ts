import { CasePermission, OrgRole, PackageSku } from "@prisma/client";
import OrganizationRepo from "../repositories/organization.repository";
import OrganizationMemberRepo from "../repositories/organization-member.repository";
import CaseAccess from "../utils/case-access";
import HttpError from "../utils/http-error";
import { slugify } from "../utils/slug";

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

  static async list(userId: string) {
    return OrganizationRepo.listForUser(userId);
  }

  static async getById(id: string, userId: string) {
    const org = await OrganizationRepo.findByIdForUser(id, userId);
    if (!org) throw new HttpError("Organization not found", 404);
    return org;
  }

  /** Resolves the caller's membership in an org, or throws 403 if they're not a member.
   * Used by resolve-organization.middleware to populate req.organization for every
   * org-scoped resource route (cases, documents, consultations, bookmarks, etc.). */
  static async requireMembership(organizationId: string, userId: string) {
    const membership = await OrganizationMemberRepo.find(organizationId, userId);
    if (!membership) throw new HttpError("Not a member of this organization", 403);
    return membership;
  }

  static async addMember(orgId: string, actorId: string, userId: string, role: OrgRole) {
    const org = await OrganizationRepo.findByIdForUser(orgId, actorId);
    if (!org) throw new HttpError("Organization not found", 404);
    const actor = org.members.find((m) => m.userId === actorId);
    if (!actor || (actor.role !== "OWNER" && actor.role !== "PARTNER")) {
      throw new HttpError("Not allowed to add members", 403);
    }
    return OrganizationRepo.addMember(orgId, userId, role);
  }

  static async removeMember(orgId: string, actorId: string, userId: string) {
    const org = await OrganizationRepo.findByIdForUser(orgId, actorId);
    if (!org) throw new HttpError("Organization not found", 404);
    const actor = org.members.find((m) => m.userId === actorId);
    if (!actor || actor.role !== "OWNER") throw new HttpError("Not allowed to remove members", 403);
    if (userId === actorId) throw new HttpError("Owner cannot remove themselves", 400);
    await OrganizationRepo.removeMember(orgId, userId);
  }

  static async attachCase(orgId: string, caseId: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const org = await OrganizationRepo.findByIdForUser(orgId, userId);
    if (!org) throw new HttpError("Organization not found", 404);
    const updated = await OrganizationRepo.attachCase(caseId, orgId);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "org.attach_case", payload: { organizationId: orgId } });
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
