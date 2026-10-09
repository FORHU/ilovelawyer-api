import prisma from "../lib/prisma";
import HttpError from "./http-error";
import { CasePermission, ClientSide, OrganizationRole, Prisma } from "@prisma/client";
import { TenantCode, asTenantCode } from "../types/tenant-code";

const EDIT_PERMS: CasePermission[] = ["EDIT", "ADMIN"];
const ORG_EDITORS: OrganizationRole[] = ["OWNER", "ADMIN"];

/** Having created a case is attribution, not access: an organization's case is reached through
 * membership (or a per-case grant), so its creator loses it on leaving — they keep their
 * portfolio copy instead (see CaseCopySvc). Creator access only covers a case with no
 * organization, and the creator's own personal workspace (their portfolio), which they reach
 * from whichever organization they're in. */
function ownedByUser(userId: string): Prisma.CaseWhereInput[] {
  return [{ userId, organizationId: null }, { organization: { isPersonal: true, createdById: userId } }];
}

/** Org membership that reaches a case: any accepted member, or only `roles` when given. A
 * confidential case (#346) is the exception — membership alone no longer reaches it, org ADMIN
 * included (D6); only the organization's OWNER keeps it (D5). Everyone else needs a grant. */
/** A per-case grant that can change the case (EDIT, or ADMIN to share it on). A portfolio case is
 * only ever shared to read (see OrganizationSvc.grantAccess), so a grant there never counts here
 * even if one were stored. */
function changingGrant(userId: string, permissions: CasePermission[]): Prisma.CaseWhereInput {
  return { accesses: { some: { userId, permission: { in: permissions } } }, NOT: { organization: { isPersonal: true } } };
}

function viaMembership(userId: string, roles?: OrganizationRole[]): Prisma.CaseWhereInput[] {
  return [
    { confidential: false, organization: { members: { some: { userId, status: "ACCEPTED", ...(roles ? { role: { in: roles } } : {}) } } } },
    { organization: { members: { some: { userId, status: "ACCEPTED", role: "OWNER" } } } },
  ];
}

export default class CaseAccess {
  /** The cases `userId` owns, which is narrower than the ones they can open: their own portfolio,
   * a case with no organization they created, and every case (confidential or not) of an
   * organization they are the OWNER of. A plain member, an org ADMIN, a creator who has left, or
   * someone holding only a per-case grant can open a case but does not own it. This is what the
   * personal data export may hand over: the rest belongs to the organization or to someone else. */
  static ownedWhere(userId: string): Prisma.CaseWhereInput {
    return { OR: [...ownedByUser(userId), { organization: { members: { some: { userId, status: "ACCEPTED", role: "OWNER" } } } }] };
  }

  /** The organizations `userId` owns: their personal workspace, or any they are the OWNER of. */
  static ownedOrganizationWhere(userId: string): Prisma.OrganizationWhereInput {
    return { OR: [{ isPersonal: true, createdById: userId }, { members: { some: { userId, status: "ACCEPTED", role: "OWNER" } } }] };
  }

  /** Every case `userId` can open — as a filter, for listings (the case list, documents,
   * transcriptions) so a confidential case is left out for anyone it's walled off from (D4). */
  static visibleWhere(userId: string): Prisma.CaseWhereInput {
    return { OR: [...ownedByUser(userId), { accesses: { some: { userId } } }, ...viaMembership(userId)] };
  }

  static async loadAccessibleCase(caseId: string, userId: string) {
    const record = await prisma.case.findFirst({
      where: { id: caseId, ...CaseAccess.visibleWhere(userId) },
      include: { parties: true },
    });
    if (!record) throw new HttpError("Case not found", 404);
    return record;
  }

  /** For changes anyone who can open an ordinary case may make — uploading a document, adding a
   * transcription, regenerating or editing the case mind map. On a confidential case "Can view"
   * is a level someone chose for this person, so there it means read-only: these take edit access
   * like any other change. 404 when the case can't be opened (loadAccessibleCase); 403 for a
   * view-only person, who can already see it. */
  static async assertCanContribute(caseId: string, userId: string) {
    const record = await CaseAccess.loadAccessibleCase(caseId, userId);
    if (await CaseAccess.isPortfolioShare(caseId, userId)) {
      throw new HttpError("This case was shared with you to read only", 403, "SHARE_READ_ONLY");
    }
    if (record.confidential && !(await CaseAccess.canEdit(caseId, userId))) {
      throw new HttpError("You have view-only access to this confidential case", 403);
    }
    return record;
  }

  /** Whether `userId` reaches this case through a share of someone else's portfolio case — which
   * is read-only. False for the owner, and for any organization case. */
  static async isPortfolioShare(caseId: string, userId: string): Promise<boolean> {
    const record = await prisma.case.findFirst({
      where: { id: caseId, organization: { isPersonal: true, createdById: { not: userId } } },
      select: { id: true },
    });
    return !!record;
  }

  /** assertCanContribute's rule as a boolean — for telling the app what to offer. */
  static async canContribute(caseId: string, userId: string): Promise<boolean> {
    if (await CaseAccess.isPortfolioShare(caseId, userId)) return false;
    return !(await CaseAccess.isConfidential(caseId)) || (await CaseAccess.canEdit(caseId, userId));
  }

  static async isConfidential(caseId: string): Promise<boolean> {
    const record = await prisma.case.findUnique({ where: { id: caseId }, select: { confidential: true } });
    return !!record?.confidential;
  }

  private static editWhere(caseId: string, userId: string): Prisma.CaseWhereInput {
    return {
      id: caseId,
      OR: [
        ...ownedByUser(userId),
        changingGrant(userId, EDIT_PERMS),
        ...viaMembership(userId, ORG_EDITORS),
      ],
    };
  }

  static async assertCanEdit(caseId: string, userId: string) {
    const record = await prisma.case.findFirst({
      where: CaseAccess.editWhere(caseId, userId),
      select: { id: true, userId: true, caseName: true, organizationId: true },
    });
    if (!record) throw new HttpError("Case not found or not editable", 404);
    return record;
  }

  /** assertCanEdit's rule as a boolean — for telling the app what to offer, not for gating. */
  static async canEdit(caseId: string, userId: string): Promise<boolean> {
    const record = await prisma.case.findFirst({ where: CaseAccess.editWhere(caseId, userId), select: { id: true } });
    return !!record;
  }

  /** Who may grant and revoke per-case access (#347, decision D3 on #331): org OWNER/ADMIN, or an
   * ADMIN grant on the case — a level no one is above, so "never above your own level" needs no
   * further check. An EDIT grant can change the case but not share it. On a confidential case an
   * org ADMIN needs that grant too, like everyone but the OWNER. */
  private static manageAccessWhere(caseId: string, userId: string): Prisma.CaseWhereInput {
    return {
      id: caseId,
      OR: [
        ...ownedByUser(userId),
        changingGrant(userId, ["ADMIN"]),
        ...viaMembership(userId, ORG_EDITORS),
      ],
    };
  }

  static async assertCanManageAccess(caseId: string, userId: string) {
    const record = await prisma.case.findFirst({
      where: CaseAccess.manageAccessWhere(caseId, userId),
      select: { id: true, caseName: true, organizationId: true, confidential: true },
    });
    if (!record) throw new HttpError("Case not found or you can't manage its access", 404);
    return record;
  }

  static async canManageAccess(caseId: string, userId: string): Promise<boolean> {
    const record = await prisma.case.findFirst({ where: CaseAccess.manageAccessWhere(caseId, userId), select: { id: true } });
    return !!record;
  }

  /**
   * The authoritative Tenant code for legal/AI operations on this case: case -> its
   * organization -> organization.tenant.code. This is the seam every legal-content
   * generator (deadline engine, prompt builders) resolves the tenant code through — never
   * from the ambient X-Organization-Id header, and never from client input. A case with no
   * organization attached yet has no tenant context to operate under, so this throws
   * rather than guessing (no silent fallback to PH). Call only after loadAccessibleCase/
   * assertCanEdit has already authorized the caller for this caseId.
   */
  static async resolveTenantCode(caseId: string): Promise<TenantCode> {
    const record = await prisma.case.findUnique({
      where: { id: caseId },
      select: { organization: { select: { tenant: { select: { code: true } } } } },
    });
    if (!record?.organization) {
      throw new HttpError("This case has no organization/tenant context — attach it to an organization first", 409);
    }
    return asTenantCode(record.organization.tenant.code);
  }

  /**
   * The case's selected UK legal system (England and Wales / Scotland / Northern Ireland —
   * see Case.ukJurisdiction), null if unset. Distinct from resolveTenantCode above — this is
   * the sub-national split within the UK tenant, used to steer prompt framing and to gate
   * deadline calculation, which today only implements England & Wales rules.
   */
  static async resolveUkJurisdiction(caseId: string): Promise<string | null> {
    const record = await prisma.case.findUnique({ where: { id: caseId }, select: { ukJurisdiction: true } });
    return record?.ukJurisdiction ?? null;
  }

  /** Which side the lawyer acts for (Case.clientSide), or null when they haven't said. */
  static async resolveClientSide(caseId: string): Promise<ClientSide | null> {
    const record = await prisma.case.findUnique({ where: { id: caseId }, select: { clientSide: true } });
    return record?.clientSide ?? null;
  }

  /**
   * Deadlines default to requiring two independent confirmations (a second-pair-of-eyes
   * safety check). A SOLO-package organization has exactly one seat, so that bar can never be
   * met by design — solo cases require only one confirmation instead of two. Call only after
   * assertCanEdit/loadAccessibleCase has already authorized the caller for this caseId.
   */
  static async requiredConfirmations(caseId: string): Promise<number> {
    const record = await prisma.case.findUnique({
      where: { id: caseId },
      select: { organization: { select: { packageSku: true } } },
    });
    return record?.organization?.packageSku === "SOLO" ? 1 : 2;
  }
}
