import prisma from "../lib/prisma";
import HttpError from "./http-error";
import { CasePermission } from "@prisma/client";
import { TenantCode, asTenantCode } from "../types/tenant-code";

const EDIT_PERMS: CasePermission[] = ["EDIT", "ADMIN"];

export default class CaseAccess {
  static async loadAccessibleCase(caseId: string, userId: string) {
    const record = await prisma.case.findFirst({
      where: {
        id: caseId,
        OR: [
          { userId },
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
          { userId },
          { accesses: { some: { userId, permission: { in: EDIT_PERMS } } } },
          { organization: { members: { some: { userId, status: "ACCEPTED", role: { in: ["OWNER", "ADMIN"] } } } } },
        ],
      },
      select: { id: true, userId: true },
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
