import { CasePermission, OrganizationRole, OrganizationMemberStatus, OrganizationStatus, PackageSku } from "@prisma/client";
import OrganizationRepo from "../repositories/organization.repository";
import OrganizationMemberRepo from "../repositories/organization-member.repository";
import OrganizationInviteRepo from "../repositories/organization-invite.repository";
import OrganizationEmailInviteRepo from "../repositories/organization-email-invite.repository";
import CaseCopyRepo from "../repositories/case-copy.repository";
import CaseRepo from "../repositories/case.repository";
import CaseShareRepo from "../repositories/case-share.repository";
import CaseShareSvc from "./case-share.service";
import CaseCopyQueue from "../queues/case-copy.queue";
import AuthRepo from "../repositories/auth.repository";
import TenantRepo from "../repositories/tenant.repository";
import CaseAccess from "../utils/case-access";
import HttpError from "../utils/http-error";
import { hasOrgRole } from "../utils/org-role";
import { sendEmail } from "../utils/mailer";
import { renderTemplate } from "../utils/template";
import { slugify } from "../utils/slug";
import { emailLinkOrigin } from "../utils/tenant-host";
import { normalizeEmail } from "../utils/auth.utils";
import { TenantCode } from "../types/tenant-code";
import NotificationSvc from "./notification.service";
import SecurityAuditSvc from "./security-audit.service";
import AuditSvc, { AuditAction } from "./audit.service";
import logger from "../utils/logger";

export default class OrganizationSvc {
  /** `personal` is onboarding's "Skip for now": a private workspace the app never presents as
   * an organization (see Organization.isPersonal). A real organization is always a new one —
   * the personal workspace stays behind as the user's portfolio, so cases made solo never
   * become the organization's (see getPortfolio). */
  static async create(
    userId: string,
    name: string,
    packageSku: PackageSku | undefined,
    tenantCode: TenantCode,
    personal = false,
  ) {
    const tenantId = await TenantRepo.findIdByCode(tenantCode);
    // The controller already validated tenantCode resolved to something — a miss here means
    // the Tenant seed row itself is missing, a server misconfiguration, not a client error.
    if (!tenantId) throw new HttpError(`No Tenant seeded for code "${tenantCode}"`, 500);

    const existing = await OrganizationMemberRepo.findAnyForUser(userId);
    const inPersonal = !!existing?.organization.isPersonal && existing.status === OrganizationMemberStatus.ACCEPTED;
    if (existing && !inPersonal) {
      throw new HttpError("You already belong to an organization.", 409);
    }

    if (personal) {
      // Idempotent — a retried Skip just returns the workspace they already have.
      if (inPersonal) return OrganizationRepo.activatePersonal(existing!.organizationId, userId, { addMember: false });
      const dormant = await OrganizationRepo.findDormantPersonal(userId, tenantId);
      if (dormant) return OrganizationRepo.activatePersonal(dormant.id, userId, { addMember: true });
      const slug = await OrganizationSvc.generateUniqueSlug(name);
      return OrganizationRepo.create(userId, name, slug, "SOLO", tenantId, true);
    }

    const slug = await OrganizationSvc.generateUniqueSlug(name);
    const org = await OrganizationRepo.create(userId, name, slug, packageSku ?? "PROFESSIONAL", tenantId, false, { parkCurrent: inPersonal });
    await SecurityAuditSvc.record({
      action: "org.created",
      actorId: userId,
      organizationId: org.id,
      targetType: "organization",
      targetId: org.id,
      payload: { packageSku: org.packageSku },
    });
    return org;
  }

  /** The caller's portfolio: their personal workspace, which holds the cases they made solo and
   * the copies they keep of cases they made in organizations they've left. Created on demand,
   * in their current organization's tenant. While they're in an organization they reach it
   * without being its member (see requireMembership); if they're in it, it's their workspace. */
  static async getPortfolio(userId: string) {
    const current = await OrganizationMemberRepo.findAnyForUser(userId);
    if (!current) throw new HttpError("Join or create a workspace first", 409);
    const portfolio = current.organization.isPersonal
      ? await OrganizationRepo.findById(current.organizationId)
      : await OrganizationSvc.ensurePersonal(userId, current.organization.tenantId);
    if (!portfolio) throw new HttpError("Organization not found", 404);
    const tenant = { code: current.organization.tenant.code };
    const copies = await CaseCopyRepo.listUnfinishedForUser(userId, portfolio.id);
    return { ...portfolio, tenant, role: OrganizationRole.OWNER, copies };
  }

  /** The user's personal workspace in `tenantId`, made (without a membership) if they have none. */
  private static async ensurePersonal(userId: string, tenantId: string) {
    const existing = await OrganizationRepo.findPersonal(userId, tenantId);
    if (existing) return existing;
    const user = await AuthRepo.findById(userId);
    const name = user?.name || user?.username || "Personal workspace";
    return OrganizationRepo.createPersonalWithoutMember(userId, name, await OrganizationSvc.generateUniqueSlug(name), tenantId);
  }

  private static async generateUniqueSlug(name: string): Promise<string> {
    const base = slugify(name);
    let slug = base;
    while (await OrganizationRepo.findBySlug(slug)) {
      slug = `${base}-${Math.floor(1000 + Math.random() * 9000)}`;
    }
    return slug;
  }

  /** Orgs the given user is a member of, with their role in each. An invite doesn't count as
   * belonging yet — see getPendingInviteForUser. */
  static async listForUser(userId: string) {
    const orgs = await OrganizationRepo.listForUser(userId);
    // Each org was fetched with `members` pre-filtered to this user (see repo), so it's always
    // exactly one row — flatten it into a plain `role` field.
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
    const updated = await OrganizationRepo.update(id, data);
    await SecurityAuditSvc.record({
      action: "org.updated",
      organizationId: id,
      targetType: "organization",
      targetId: id,
      payload: { fields: Object.keys(data).filter((key) => data[key as keyof typeof data] !== undefined) },
    });
    return updated;
  }

  /** Members, then outstanding invites as PENDING rows (the shape the app's members list renders).
   * An invite to an address with no account yet has no user: userId is null and `user` carries
   * just the email. */
  static async listMembers(organizationId: string) {
    const [members, invites, emailInvites] = await Promise.all([
      OrganizationMemberRepo.list(organizationId),
      OrganizationInviteRepo.list(organizationId),
      OrganizationEmailInviteRepo.list(organizationId),
    ]);
    const pending = invites.map((invite) => ({
      ...invite,
      status: OrganizationMemberStatus.PENDING,
      updatedAt: invite.createdAt,
    }));
    const pendingSignup = emailInvites.map(({ email, ...invite }) => ({
      ...invite,
      userId: null,
      status: OrganizationMemberStatus.PENDING,
      updatedAt: invite.createdAt,
      user: { id: null, name: null, email, username: null, avatarUrl: null },
    }));
    return [...members, ...pending, ...pendingSignup];
  }

  /** Resolves the caller's membership/role in an org, or throws 403 if they're not a member.
   * A PENDING invite doesn't count — the invitee has no access until they accept it. */
  static async requireMembership(organizationId: string, userId: string) {
    const membership = await OrganizationMemberRepo.find(organizationId, userId);
    if (!membership) {
      // Their own personal workspace is their portfolio, open to them from any organization.
      const portfolio = await OrganizationRepo.findOwnPersonal(organizationId, userId);
      if (portfolio) return { organizationId, userId, role: OrganizationRole.OWNER, organization: { tenant: portfolio.tenant } };
      throw new HttpError("Not a member of this organization", 403);
    }
    if (membership.status === OrganizationMemberStatus.PENDING) {
      throw new HttpError("Your invite to this organization is still pending", 403);
    }
    return membership;
  }

  /** Invites a user by email — including one who already belongs to another organization, who
   * then decides whether to leave it (acceptInvite) or stay (declineInvite). An address with no
   * account yet gets an email invite to sign up instead (see inviteByEmail). Only an OWNER can
   * grant the OWNER role. */
  static async inviteMember(
    organizationId: string,
    actingRole: OrganizationRole,
    actingUserId: string,
    email: string,
    role: OrganizationRole,
    requestOrigin: string | null = null,
  ) {
    if (role === OrganizationRole.OWNER && !hasOrgRole(actingRole, OrganizationRole.OWNER)) {
      throw new HttpError("Only an owner can grant the owner role", 403);
    }

    const [organization, inviter] = await Promise.all([
      OrganizationRepo.findById(organizationId),
      AuthRepo.findById(actingUserId),
    ]);
    // Not reachable from the app (a personal workspace has no invite UI) — a team needs a
    // real organization first, which creating one upgrades this workspace into.
    if (organization?.isPersonal) {
      throw new HttpError("Create an organization before inviting teammates", 400);
    }

    const inviterName = inviter?.name || "A team member";
    const orgName = organization?.name ?? "";
    // The inviting org's tenant site, not the bare CLIENT_URL[0]. See emailLinkOrigin.
    const origin = emailLinkOrigin(organization?.tenant.code, requestOrigin);

    const user = await AuthRepo.findByEmail(email);
    if (!user) {
      return OrganizationSvc.inviteByEmail(organizationId, actingUserId, normalizeEmail(email), role, { inviterName, orgName, origin });
    }

    if (await OrganizationMemberRepo.find(organizationId, user.id)) {
      throw new HttpError("User is already a member of this organization", 409);
    }

    let outstanding = await OrganizationInviteRepo.findForUser(user.id);
    // An invite to an organization that's being deleted can't be accepted any more, so it mustn't
    // hold the invitee's one invite slot either.
    if (outstanding && outstanding.organization.status !== OrganizationStatus.ACTIVE) {
      await OrganizationInviteRepo.delete(user.id);
      outstanding = null;
    }
    if (outstanding) {
      const message =
        outstanding.organizationId === organizationId
          ? "User already has a pending invite to this organization"
          : "This user already has a pending invite from another organization. They must accept or decline it first.";
      throw new HttpError(message, 409);
    }

    const invite = await OrganizationInviteRepo.create(organizationId, user.id, role);
    await SecurityAuditSvc.record({
      action: "org.member_invited",
      actorId: actingUserId,
      organizationId,
      targetType: "user",
      targetId: user.id,
      payload: { role, email: user.email },
    });
    await AuditSvc.record({
      action: AuditAction.OrgInviteSent,
      actorId: actingUserId,
      payload: { organizationId, inviteeId: user.id, role },
    });

    const html = await renderTemplate("org-invite", {
      inviterName,
      orgName,
      role,
      // Straight to the accept/decline UI (a signed-out invitee is bounced through /login?next=).
      loginLink: `${origin}/homepage/organization`,
    });
    // user.email, not the typed `email`: AuthRepo.findByEmail matched it case-insensitively,
    // so the stored address is the canonical one to send to.
    await sendEmail({ to: user.email, subject: `You've been invited to join ${orgName}`, html });

    // No organizationId: the invitee isn't in the inviting org, and an org-less notification
    // shows in whichever workspace they're in (see NotificationRepo.findMany).
    const current = await OrganizationMemberRepo.findAnyForUser(user.id);
    const switching = !!current && !current.organization.isPersonal;
    await NotificationSvc.create({
      userId: user.id,
      type: "SYSTEM",
      title: `You've been invited to join ${orgName}`,
      message: switching
        ? `${inviterName} invited you to join ${orgName} as ${role}. Accepting will remove you from your current organization.`
        : `${inviterName} invited you to join ${orgName} as ${role}.`,
      link: "/homepage/organization",
    }).catch((err) => logger.error("inviteMember: failed to create notification", { err, organizationId, userId: user.id }));

    return invite;
  }

  /** inviteMember for an address with no account: the invite waits on the email, and the email
   * asks them to sign up with it. Verifying that signup turns it into an ordinary invite and
   * approves the account (AuthSvc.autoApproveIfEnabled), so they land on the Organization page
   * ready to accept. No notification — there's no user to notify yet. */
  private static async inviteByEmail(
    organizationId: string,
    actingUserId: string,
    email: string,
    role: OrganizationRole,
    { inviterName, orgName, origin }: { inviterName: string; orgName: string; origin: string },
  ) {
    let outstanding = await OrganizationEmailInviteRepo.findByEmail(email);
    // Same as inviteMember: a dead organization's invite doesn't hold the address's one slot.
    if (outstanding && outstanding.organization.status !== OrganizationStatus.ACTIVE) {
      await OrganizationEmailInviteRepo.delete(outstanding.id);
      outstanding = null;
    }
    if (outstanding) {
      const message =
        outstanding.organizationId === organizationId
          ? "This email already has a pending invite to this organization"
          : "This email already has a pending invite from another organization. They must sign up and accept or decline it first.";
      throw new HttpError(message, 409);
    }

    const invite = await OrganizationEmailInviteRepo.create(organizationId, email, role);
    await AuditSvc.record({
      action: AuditAction.OrgInviteSent,
      actorId: actingUserId,
      payload: { organizationId, inviteeEmail: email, role },
    });

    // The sign-up tab with the address filled in; after verifying they continue to the
    // Organization page to accept.
    const params = new URLSearchParams({ tab: "signup", email, next: "/homepage/organization" });
    const html = await renderTemplate("org-invite-signup", {
      inviterName,
      orgName,
      role,
      signupLink: `${origin}/login?${params}`,
    });
    await sendEmail({ to: email, subject: `You've been invited to join ${orgName}`, html });

    return invite;
  }

  /** The caller's own pending invite, if any (a user can have at most one). An invite to an
   * organization that's being deleted isn't one any more — accepting it would fail. */
  static async getPendingInviteForUser(userId: string) {
    const invite = await OrganizationInviteRepo.findForUser(userId);
    if (!invite || invite.organization.status !== OrganizationStatus.ACTIVE) return null;
    return { ...invite, status: OrganizationMemberStatus.PENDING };
  }

  /** Joins the inviting organization. Someone already in a real organization leaves it as part
   * of accepting, under the same rules as leave() — so a last owner with teammates has to hand
   * ownership over first — and takes their work there along to their portfolio, as exit() does.
   * A personal workspace is just parked; it stays their portfolio. */
  static async acceptInvite(organizationId: string, userId: string) {
    const invite = await OrganizationInviteRepo.findForUser(userId);
    if (!invite || invite.organizationId !== organizationId) {
      throw new HttpError("No pending invite found for this organization", 404);
    }
    // Its last member left, so it's archived for deletion and nobody can join it.
    if (invite.organization.status !== OrganizationStatus.ACTIVE) {
      await OrganizationInviteRepo.delete(userId);
      throw new HttpError("This invitation is no longer valid.", 410);
    }

    const audit = () =>
      AuditSvc.record({ action: AuditAction.OrgInviteAccepted, actorId: userId, payload: { organizationId, role: invite.role } });

    const current = await OrganizationMemberRepo.findAnyForUser(userId);
    const recordAccepted = () =>
      SecurityAuditSvc.record({
        action: "org.invite_accepted",
        actorId: userId,
        organizationId,
        targetType: "user",
        targetId: userId,
        payload: { role: invite.role },
      });
    if (!current || current.organization.isPersonal) {
      const member = await OrganizationInviteRepo.accept(invite, current);
      await recordAccepted();
      await audit();
      return member;
    }

    await this.assertCanLeave(current.organizationId, current.role);
    const portfolio = await OrganizationSvc.ensurePersonal(userId, current.organization.tenantId);
    let archived = false;
    const member = await OrganizationInviteRepo.accept(invite, current, async (tx) => {
      await CaseCopyRepo.carryOverIn(tx, {
        sourceOrganizationId: current.organizationId,
        sourceOrganizationName: current.organization.name,
        userId,
        targetOrganizationId: portfolio.id,
      });
      archived = await OrganizationRepo.archiveIfEmptyIn(tx, current.organizationId, userId);
    });
    CaseCopyQueue.kick();
    // Accepting left their previous organization — that firm's log says so too.
    await SecurityAuditSvc.record({
      action: "org.member_left",
      actorId: userId,
      organizationId: current.organizationId,
      targetType: "user",
      targetId: userId,
      payload: { role: current.role, reason: "joined_another_organization" },
    });
    if (archived) await OrganizationSvc.recordArchived(current.organizationId, userId);
    await recordAccepted();
    await audit();
    return member;
  }

  /** Turns the invite down; whatever organization the user is in now is left alone. */
  static async declineInvite(organizationId: string, userId: string) {
    const invite = await OrganizationInviteRepo.findForUser(userId);
    if (!invite || invite.organizationId !== organizationId) {
      throw new HttpError("No pending invite found for this organization", 404);
    }
    await OrganizationInviteRepo.delete(userId);
    await SecurityAuditSvc.record({
      action: "org.invite_declined",
      actorId: userId,
      organizationId,
      targetType: "user",
      targetId: userId,
      payload: { role: invite.role },
    });
    await AuditSvc.record({ action: AuditAction.OrgInviteDeclined, actorId: userId, payload: { organizationId } });
    // Invites used to park a personal workspace when sent (before 20261007150000_organization_invites)
    // — someone declining one of those gets it back instead of being left with no workspace.
    if (await OrganizationMemberRepo.findAnyForUser(userId)) return;
    const dormant = await OrganizationRepo.findDormantPersonal(userId);
    if (dormant) await OrganizationRepo.activatePersonal(dormant.id, userId, { addMember: true });
  }

  /** Changes a member's role. Guards against granting OWNER without being one, and against demoting the last OWNER. */
  static async changeMemberRole(
    organizationId: string,
    actingRole: OrganizationRole,
    targetUserId: string,
    role: OrganizationRole,
    actingUserId?: string,
  ) {
    const target = await OrganizationMemberRepo.find(organizationId, targetUserId);
    if (!target) throw new HttpError("Member not found", 404);

    if (role === OrganizationRole.OWNER && !hasOrgRole(actingRole, OrganizationRole.OWNER)) {
      throw new HttpError("Only an owner can grant the owner role", 403);
    }

    if (target.role === OrganizationRole.OWNER && role !== OrganizationRole.OWNER) {
      await this.assertNotLastOwner(organizationId);
    }

    const updated = await OrganizationMemberRepo.updateRole(organizationId, targetUserId, role);
    await SecurityAuditSvc.record({
      action: "org.member_role_changed",
      organizationId,
      targetType: "user",
      targetId: targetUserId,
      payload: { from: target.role, to: role },
    });
    await AuditSvc.record({
      action: AuditAction.OrgMemberRoleChanged,
      actorId: actingUserId,
      payload: { organizationId, targetUserId, from: target.role, to: role },
    });
    return updated;
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

    await OrganizationSvc.exit(organizationId, targetUserId);
    await SecurityAuditSvc.record({
      action: "org.member_removed",
      actorId: actingUserId,
      organizationId,
      targetType: "user",
      targetId: targetUserId,
      payload: { role: target.role },
    });
    await AuditSvc.record({ action: AuditAction.OrgMemberRemoved, actorId: actingUserId, payload: { organizationId, targetUserId } });
  }

  /** Self-service: a member removes their own membership. An OWNER who isn't the sole member
   * can only leave once another OWNER exists (this app allows multiple OWNERs per org, same as
   * changeMemberRole/removeMember — see assertNotLastOwner) — otherwise they must promote a
   * teammate to OWNER first. A sole-member OWNER may leave: the organization is then archived
   * for deletion (see OrganizationRepo.archiveIfEmptyIn) and deleted after the grace period. */
  static async leave(organizationId: string, userId: string) {
    const membership = await OrganizationMemberRepo.find(organizationId, userId);
    if (!membership) throw new HttpError("Not a member of this organization", 404);

    // It's their portfolio, and leaving it would strand them with no workspace.
    const organization = await OrganizationRepo.findById(organizationId);
    if (organization?.isPersonal) throw new HttpError("A personal workspace can't be left", 400);

    await this.assertCanLeave(organizationId, membership.role);

    const { archived } = await OrganizationSvc.exit(organizationId, userId);
    await SecurityAuditSvc.record({
      action: "org.member_left",
      actorId: userId,
      organizationId,
      targetType: "user",
      targetId: userId,
      payload: { role: membership.role },
    });
    await AuditSvc.record({ action: AuditAction.OrgMemberLeft, actorId: userId, payload: { organizationId } });
    if (archived) await OrganizationSvc.recordArchived(organizationId, userId);
  }

  /** Audit trail for an organization its last member just left (see archiveIfEmptyIn). */
  private static async recordArchived(organizationId: string, userId: string) {
    await SecurityAuditSvc.record({
      action: "org.archived",
      actorId: userId,
      organizationId,
      targetType: "organization",
      targetId: organizationId,
      payload: { reason: "last_member_left" },
    });
    await AuditSvc.record({ action: AuditAction.OrgArchived, actorId: userId, payload: { organizationId } });
  }

  /** How a member stops belonging to an organization, whether they left or were removed: the
   * membership goes, their work there is carried over to their portfolio in the same transaction
   * (copies queued of the cases they created and the standalone consultations they started, their
   * own calendar moved — see CaseCopyRepo.carryOverIn), and they land in that portfolio — their
   * personal workspace, in this organization's tenant, made if they had none. The organization
   * keeps its originals — and if they were its last member, it's archived for deletion in that
   * same transaction (`archived`). */
  private static async exit(organizationId: string, userId: string) {
    const organization = await OrganizationRepo.findById(organizationId);
    if (!organization) throw new HttpError("Organization not found", 404);
    const portfolio = await OrganizationSvc.ensurePersonal(userId, organization.tenantId);
    let archived = false;
    await OrganizationMemberRepo.remove(organizationId, userId, async (tx) => {
      await CaseCopyRepo.carryOverIn(tx, {
        sourceOrganizationId: organizationId,
        sourceOrganizationName: organization.name,
        userId,
        targetOrganizationId: portfolio.id,
      });
      archived = await OrganizationRepo.archiveIfEmptyIn(tx, organizationId, userId);
    });
    await OrganizationRepo.activatePersonal(portfolio.id, userId, { addMember: true });
    CaseCopyQueue.kick();
    return { archived };
  }

  /** Shared by leave() and acceptInvite(): an OWNER can walk away from an org they're alone
   * in, but not leave teammates without an owner. */
  private static async assertCanLeave(organizationId: string, role: OrganizationRole) {
    if (role !== OrganizationRole.OWNER) return;
    const members = await OrganizationMemberRepo.list(organizationId);
    if (members.length <= 1) return;
    const ownerCount = await OrganizationMemberRepo.countByRole(organizationId, OrganizationRole.OWNER);
    if (ownerCount <= 1) {
      throw new HttpError("You're this organization's only owner. Make another member an owner before you leave.", 400);
    }
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
    const caseRecord = await CaseAccess.assertCanEdit(caseId, userId);
    const org = await OrganizationRepo.findByIdForUser(organizationId, userId);
    if (!org) throw new HttpError("Organization not found", 404);
    const updated = await OrganizationRepo.attachCase(caseId, organizationId);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "org.attach_case", payload: { organizationId } });
    await SecurityAuditSvc.record({
      action: "org.case_attached",
      actorId: userId,
      organizationId,
      targetType: "case",
      targetId: caseId,
      caseId,
      payload: { fromOrganizationId: caseRecord.organizationId ?? null },
    });
    return updated;
  }

  /** Sharing (#347): only someone who can manage the case's access may grant (see
   * CaseAccess.assertCanManageAccess — an EDIT holder can't), and in v1 only to an accepted member
   * of the case's own organization. Granting again changes the level (upsert). */
  static async grantAccess(caseId: string, actorId: string, userId: string, permission: CasePermission) {
    // A portfolio case is shared with individual people, read-only — its own rules.
    if (await CaseShareRepo.findPortfolioCase(caseId)) return CaseShareSvc.grant(caseId, actorId, userId, permission);
    const caseRecord = await CaseAccess.assertCanManageAccess(caseId, actorId);
    if (!caseRecord.organizationId) throw new HttpError("This case has no organization to share it within", 400);
    const membership = await OrganizationMemberRepo.find(caseRecord.organizationId, userId);
    if (membership?.status !== "ACCEPTED") {
      throw new HttpError("A case can only be shared with an accepted member of its organization", 400);
    }
    const access = await OrganizationRepo.grantCaseAccess(caseId, userId, permission);
    await OrganizationRepo.writeAudit({ caseId, actorId, action: "case.grant_access", payload: { userId, permission } });
    await SecurityAuditSvc.record({
      action: "case.access_granted",
      actorId,
      organizationId: caseRecord.organizationId ?? null,
      targetType: "user",
      targetId: userId,
      caseId,
      payload: { permission },
    });

    if (userId !== actorId) {
      await NotificationSvc.create({
        userId,
        organizationId: caseRecord.organizationId ?? undefined,
        type: "CASE_UPDATE",
        title: "You were given access to a case",
        message: `You now have ${permission.toLowerCase()} access to "${caseRecord.caseName}"`,
        link: `/homepage/terminal/${caseId}`,
      }).catch((err) => logger.error("grantAccess: failed to create notification", { err, caseId, userId }));
    }

    return access;
  }

  /** Removes an explicit grant. Access someone has through their org role isn't a grant, so
   * there's nothing to revoke for it — that 404s rather than looking like it worked. */
  static async revokeAccess(caseId: string, actorId: string, userId: string) {
    if (await CaseShareRepo.findPortfolioCase(caseId)) return CaseShareSvc.revoke(caseId, actorId, userId);
    await CaseAccess.assertCanManageAccess(caseId, actorId);
    const removed = await OrganizationRepo.revokeCaseAccess(caseId, userId);
    if (!removed) throw new HttpError("This person has no access grant on the case", 404);
    await OrganizationRepo.writeAudit({ caseId, actorId, action: "case.revoke_access", payload: { userId } });
  }

  /** Who can reach the case and how, for the sharing panel: every accepted member of its
   * organization (all of whom can read it today) with their org role and grant, plus any grant
   * held by someone outside it. `canEdit`/`canManage` say what the caller may do — the app uses
   * them rather than guessing from the org role, which misses per-case grants. */
  static async listAccess(caseId: string, actorId: string) {
    const caseRecord = await CaseAccess.loadAccessibleCase(caseId, actorId);
    const portfolio = await CaseShareRepo.findPortfolioCase(caseId);
    if (portfolio) return OrganizationSvc.listPortfolioAccess(caseId, actorId, portfolio, caseRecord.confidential);
    const [members, grants, canEdit, canManage] = await Promise.all([
      caseRecord.organizationId ? OrganizationMemberRepo.list(caseRecord.organizationId) : [],
      OrganizationRepo.listCaseAccess(caseId),
      CaseAccess.canEdit(caseId, actorId),
      CaseAccess.canManageAccess(caseId, actorId),
    ]);
    const grantByUser = new Map(grants.map((g) => [g.userId, g.permission]));

    const people = members
      .filter((m) => m.status === "ACCEPTED")
      .map((m) => ({
        userId: m.userId,
        name: m.user.name,
        email: m.user.email,
        username: m.user.username,
        avatarUrl: m.user.avatarUrl,
        orgRole: m.role as OrganizationRole | null,
        grant: grantByUser.get(m.userId) ?? null,
      }));
    const listed = new Set(people.map((p) => p.userId));
    for (const g of grants) {
      if (listed.has(g.userId)) continue;
      people.push({
        userId: g.userId,
        name: g.user.name,
        email: g.user.email,
        username: g.user.username,
        avatarUrl: null,
        orgRole: null,
        grant: g.permission,
      });
    }
    return { portfolio: false, shareable: canManage, confidential: caseRecord.confidential, canEdit, canManage, canContribute: await CaseAccess.canContribute(caseId, actorId), people };
  }

  /** listAccess for a portfolio case: the owner manages it and everyone else can only read. Only
   * the owner sees who it's shared with; a recipient just learns that it's read-only for them. */
  private static async listPortfolioAccess(
    caseId: string,
    actorId: string,
    portfolio: { copiedFromCaseId: string | null; organization: { createdById: string } | null },
    confidential: boolean,
  ) {
    const isOwner = portfolio.organization?.createdById === actorId;
    const shares = isOwner ? await CaseShareSvc.listShares(caseId) : [];
    const people = shares
      .filter((share) => share.user.id !== actorId)
      .map((share) => ({
        userId: share.user.id,
        name: share.user.name,
        email: share.user.email,
        username: share.user.username,
        avatarUrl: share.user.avatarUrl,
        orgRole: null,
        grant: share.permission,
        sharedAt: share.createdAt,
      }));
    return {
      portfolio: true,
      // A copy of an organization's case stays private to its holder.
      shareable: isOwner && !portfolio.copiedFromCaseId,
      confidential,
      canEdit: isOwner,
      canManage: isOwner,
      canContribute: isOwner,
      people,
    };
  }

  /** The owner looks up the one registered user with this exact email before sharing a portfolio
   * case with them. */
  static async lookupShareRecipient(caseId: string, actorId: string, email: string) {
    return CaseShareSvc.lookup(caseId, actorId, email);
  }

  /** Marks a case confidential or ordinary (#346). Whoever can manage its access may (D7). Marking
   * it first gives the marker an ADMIN grant (D8) — an org ADMIN would otherwise wall themselves
   * off the moment it took effect. Unmarking leaves grants as they are. Audited either way. */
  static async setConfidential(caseId: string, actorId: string, confidential: boolean) {
    // A portfolio case is already private to its owner and the people they share it with.
    if (await CaseShareRepo.findPortfolioCase(caseId)) {
      throw new HttpError("A case in your portfolio is already private to you", 400);
    }
    const caseRecord = await CaseAccess.assertCanManageAccess(caseId, actorId);
    if (caseRecord.confidential === confidential) return { confidential };
    if (confidential) await OrganizationRepo.grantCaseAccess(caseId, actorId, "ADMIN");
    await CaseRepo.setConfidential(caseId, confidential);
    await OrganizationRepo.writeAudit({
      caseId,
      actorId,
      action: confidential ? "case.confidential_set" : "case.confidential_unset",
    });
    return { confidential };
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
