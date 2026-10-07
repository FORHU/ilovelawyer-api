import prisma from "../lib/prisma";
import HttpError from "./http-error";
import { CasePermission, ClientSide, Prisma } from "@prisma/client";
import { TenantCode, asTenantCode } from "../types/tenant-code";

const EDIT_PERMS: CasePermission[] = ["EDIT", "ADMIN"];

/** Having created a case is attribution, not access: an organization's case is reached through
 * membership (or a per-case grant), so its creator loses it on leaving — they keep their
 * portfolio copy instead (see CaseCopySvc). Creator access only covers a case with no
 * organization, and the creator's own personal workspace (their portfolio), which they reach
 * from whichever organization they're in. */
function ownedByUser(userId: string): Prisma.CaseWhereInput[] {
  return [{ userId, organizationId: null }, { organization: { isPersonal: true, createdById: userId } }];
}

export default class CaseAccess {
  static async loadAccessibleCase(caseId: string, userId: string) {
    const record = await prisma.case.findFirst({
      where: {
        id: caseId,
        OR: [
          ...ownedByUser(userId),
          { accesses: { some: { userId } } },
          { organization: { members: { some: { userId, status: "ACCEPTED" } } } },
        ],
      },
      include: { parties: true },
    });
    if (!record) throw new HttpError("Case not found", 404);
    return record;
  }

  static async assertCanEdit(caseId: string, userId: string) {
    const record = await prisma.case.findFirst({
      where: {
        id: caseId,
        OR: [
          ...ownedByUser(userId),
          { accesses: { some: { userId, permission: { in: EDIT_PERMS } } } },
          { organization: { members: { some: { userId, status: "ACCEPTED", role: { in: ["OWNER", "ADMIN"] } } } } },
        ],
      },
      select: { id: true, userId: true, caseName: true, organizationId: true },
    });
    if (!record) throw new HttpError("Case not found or not editable", 404);
    return record;
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
