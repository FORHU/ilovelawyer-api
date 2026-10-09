import prisma from "../lib/prisma";
import { CasePermission, OrganizationRole, OrganizationMemberStatus, OrganizationStatus, PackageSku, Prisma } from "@prisma/client";
import ChatRepo from "./chat.repository";
import { organizationDeletionDueAt } from "../constants/organization-deletion.constants";

export default class OrganizationRepo {
  /** Creates the org and its first membership (creator as OWNER, ACCEPTED) atomically.
   * `tenantId` must already be trusted-resolved by the caller (see
   * resolveTenantCodeFromRequest / TenantRepo.findIdByCode) — this layer just persists
   * whatever it's given. `parkCurrent` first drops the creator's current membership — their
   * personal workspace, which stays behind as their portfolio. */
  static async create(
    createdById: string,
    name: string,
    slug: string,
    packageSku: PackageSku = "PROFESSIONAL",
    tenantId: string,
    isPersonal = false,
    { parkCurrent = false }: { parkCurrent?: boolean } = {},
  ) {
    return prisma.$transaction(async (tx) => {
      if (parkCurrent) await tx.organizationMember.deleteMany({ where: { userId: createdById } });
      const org = await tx.organization.create({
        data: { name, slug, packageSku, createdById, tenantId, isPersonal },
      });
      await tx.organizationMember.create({
        data: { organizationId: org.id, userId: createdById, role: OrganizationRole.OWNER, status: OrganizationMemberStatus.ACCEPTED },
      });
      return tx.organization.findUniqueOrThrow({
        where: { id: org.id },
        include: { members: true, tenant: { select: { code: true } } },
      });
    });
  }

  /** A personal workspace the user created but no longer belongs to — they joined another
   * org through an invite (see OrganizationInviteRepo.accept). Its data is still there, so
   * skipping onboarding again (or leaving that org) brings it back. */
  static async findDormantPersonal(userId: string, tenantId?: string) {
    return prisma.organization.findFirst({
      where: { createdById: userId, isPersonal: true, members: { none: {} }, ...(tenantId ? { tenantId } : {}) },
      orderBy: { createdAt: "desc" },
    });
  }

  /** Puts the user back into their own personal workspace (as its OWNER). Same return shape as
   * create(). */
  static async activatePersonal(organizationId: string, userId: string, { addMember }: { addMember: boolean }) {
    return prisma.$transaction(async (tx) => {
      if (addMember) {
        await tx.organizationMember.create({
          data: { organizationId, userId, role: OrganizationRole.OWNER, status: OrganizationMemberStatus.ACCEPTED },
        });
      }
      return tx.organization.findUniqueOrThrow({
        where: { id: organizationId },
        include: { members: true, tenant: { select: { code: true } } },
      });
    });
  }

  /** The user's personal workspace in a tenant, whether or not they're currently in it — while
   * they belong to an organization it's their portfolio (see OrganizationSvc.getPortfolio). */
  static async findPersonal(userId: string, tenantId: string) {
    return prisma.organization.findFirst({
      where: { createdById: userId, isPersonal: true, tenantId },
      orderBy: { createdAt: "desc" },
      include: { tenant: { select: { code: true } } },
    });
  }

  /** A personal workspace for someone who's in an organization right now, so it has no member —
   * it's only their portfolio until they leave. */
  static async createPersonalWithoutMember(createdById: string, name: string, slug: string, tenantId: string) {
    return prisma.organization.create({
      data: { name, slug, packageSku: "SOLO", createdById, tenantId, isPersonal: true },
      include: { tenant: { select: { code: true } } },
    });
  }

  /** `id` if it is `userId`'s own personal workspace — which they can always open (their
   * portfolio), member or not. */
  static async findOwnPersonal(id: string, userId: string) {
    return prisma.organization.findFirst({
      where: { id, isPersonal: true, createdById: userId },
      select: { id: true, tenant: { select: { code: true } } },
    });
  }

  /** Someone else's portfolio that `userId` holds a share of one of its cases in (copies of an
   * organization's case can't be shared, so a grant on one doesn't count). */
  static async findSharedPortfolio(id: string, userId: string) {
    return prisma.organization.findFirst({
      where: {
        id,
        isPersonal: true,
        createdById: { not: userId },
        cases: { some: { copiedFromCaseId: null, accesses: { some: { userId } } } },
      },
      select: { id: true, tenant: { select: { code: true } } },
    });
  }

  static async findBySlug(slug: string) {
    return prisma.organization.findUnique({ where: { slug } });
  }

  static async findById(id: string) {
    return prisma.organization.findUnique({ where: { id }, include: { tenant: { select: { code: true } } } });
  }

  static async findByIdForUser(id: string, userId: string) {
    return prisma.organization.findFirst({
      where: { id, members: { some: { userId } } },
      include: {
        members: { include: { user: { select: { id: true, email: true, name: true, username: true } } } },
        tenant: { select: { code: true } },
      },
    });
  }

  /** Orgs the given user is an ACCEPTED member of, with their role in each. An invite
   * doesn't count as belonging yet — see OrganizationInviteRepo. */
  static async listForUser(userId: string) {
    return prisma.organization.findMany({
      where: { members: { some: { userId, status: OrganizationMemberStatus.ACCEPTED } } },
      orderBy: { createdAt: "asc" },
      include: {
        members: { where: { userId, status: OrganizationMemberStatus.ACCEPTED }, select: { role: true } },
        tenant: { select: { code: true } },
      },
    });
  }

  /** Runs in the transaction that just took a membership away (a leave, or a switch to another
   * organization through an invite). An organization with no member left is archived for
   * deletion: nobody can open, join or be invited to it any more, its outstanding invites stop
   * working, and OrganizationDeletionQueue deletes it after the grace period. A personal
   * workspace with no member is just parked (see findDormantPersonal), so it's left alone.
   * Returns whether it archived. */
  static async archiveIfEmptyIn(tx: Prisma.TransactionClient, organizationId: string, archivedById: string) {
    const org = await tx.organization.findUnique({ where: { id: organizationId }, select: { isPersonal: true, status: true } });
    if (!org || org.isPersonal || org.status !== OrganizationStatus.ACTIVE) return false;
    if ((await tx.organizationMember.count({ where: { organizationId } })) > 0) return false;
    const archivedAt = new Date();
    await tx.organization.update({
      where: { id: organizationId },
      data: {
        status: OrganizationStatus.PENDING_DELETION,
        archivedAt,
        archivedById,
        deletionScheduledAt: organizationDeletionDueAt(archivedAt),
      },
    });
    return true;
  }

  /** Archived organizations whose grace period is over, a page at a time (by id, like
   * ChatRepo.findConsultationsDueForDeletion). */
  static async findDueForDeletion(now: Date, { afterId, take }: { afterId?: string; take: number }) {
    return prisma.organization.findMany({
      where: {
        status: OrganizationStatus.PENDING_DELETION,
        deletionScheduledAt: { lte: now },
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      orderBy: { id: "asc" },
      take,
      select: { id: true, name: true },
    });
  }

  /** Deletes an archived organization for good — OrganizationDeletionQueue's job once the grace
   * period is over. Its consultations go first, one at a time, through the same purge as a
   * deleted consultation (which marks their files). Then its cases are deleted explicitly
   * (Case.organization is SetNull, so deleting the organization alone would leave them behind),
   * and the organization itself, which cascades to its documents, transcriptions, notes, events,
   * invites and the rest. Files nothing references any more are marked FOR_DELETION for the
   * cleanup sweep, as DocumentSvc.delete does. Returns null, deleting nothing, when the
   * organization is gone or no longer PENDING_DELETION (support restored it meanwhile). */
  static async deletePermanently(organizationId: string) {
    const stillDue = () =>
      prisma.organization.findFirst({ where: { id: organizationId, status: OrganizationStatus.PENDING_DELETION }, select: { id: true } });
    if (!(await stillDue())) return null;

    const consultations = await prisma.consultation.findMany({ where: { organizationId }, select: { id: true } });
    let filesMarkedForDeletion = 0;
    for (const { id } of consultations) {
      filesMarkedForDeletion += (await ChatRepo.deleteConsultationPermanently(id)).filesMarkedForDeletion;
    }

    return prisma.$transaction(async (tx) => {
      const org = await tx.organization.findFirst({
        where: { id: organizationId, status: OrganizationStatus.PENDING_DELETION },
        select: { id: true },
      });
      if (!org) return null;

      const [documents, transcriptions] = await Promise.all([
        tx.document.findMany({ where: { organizationId, fileId: { not: null } }, select: { fileId: true } }),
        tx.transcription.findMany({ where: { organizationId, audioFileId: { not: null } }, select: { audioFileId: true } }),
      ]);
      const fileIds = new Set<string>([
        ...documents.flatMap((d) => (d.fileId ? [d.fileId] : [])),
        ...transcriptions.flatMap((t) => (t.audioFileId ? [t.audioFileId] : [])),
      ]);

      const { count: casesDeleted } = await tx.case.deleteMany({ where: { organizationId } });
      await tx.organization.delete({ where: { id: organizationId } });

      if (fileIds.size > 0) {
        const [stillDocuments, stillTranscriptions] = await Promise.all([
          tx.document.findMany({ where: { fileId: { in: [...fileIds] } }, select: { fileId: true } }),
          tx.transcription.findMany({ where: { audioFileId: { in: [...fileIds] } }, select: { audioFileId: true } }),
        ]);
        for (const { fileId } of stillDocuments) if (fileId) fileIds.delete(fileId);
        for (const { audioFileId } of stillTranscriptions) if (audioFileId) fileIds.delete(audioFileId);
        const { count } = await tx.file.updateMany({
          where: { id: { in: [...fileIds] } },
          data: { fileStatus: "FOR_DELETION", deletedAt: new Date() },
        });
        filesMarkedForDeletion += count;
      }
      return { casesDeleted, consultationsDeleted: consultations.length, filesMarkedForDeletion };
    });
  }

  static async update(id: string, data: { name?: string; slug?: string }) {
    return prisma.organization.update({ where: { id }, data });
  }

  // ── Case access / audit (ADR: per-case sharing within an org — see CaseAccess/AuditEvent) ──

  static async attachCase(caseId: string, organizationId: string) {
    return prisma.case.update({ where: { id: caseId }, data: { organizationId } });
  }

  static async grantCaseAccess(caseId: string, userId: string, permission: CasePermission) {
    return prisma.caseAccess.upsert({
      where: { caseId_userId: { caseId, userId } },
      create: { caseId, userId, permission },
      update: { permission },
    });
  }

  /** True when a grant was removed, false when there was none. */
  static async revokeCaseAccess(caseId: string, userId: string) {
    const result = await prisma.caseAccess.deleteMany({ where: { caseId, userId } });
    return result.count > 0;
  }

  static async listCaseAccess(caseId: string) {
    return prisma.caseAccess.findMany({
      where: { caseId },
      include: { user: { select: { id: true, email: true, name: true, username: true } } },
    });
  }

  static async listAudit(caseId: string) {
    return prisma.auditEvent.findMany({
      where: { caseId },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  }

  static async writeAudit(data: { caseId?: string; actorId?: string; action: string; payload?: object }) {
    return prisma.auditEvent.create({ data });
  }
}
