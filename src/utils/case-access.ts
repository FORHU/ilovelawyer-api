import prisma from "../lib/prisma";
import HttpError from "./http-error";
import { CasePermission } from "@prisma/client";

const EDIT_PERMS: CasePermission[] = ["EDIT", "ADMIN"];

export default class CaseAccess {
  static async loadAccessibleCase(caseId: string, userId: string) {
    const record = await prisma.case.findFirst({
      where: {
        id: caseId,
        OR: [
          { userId },
          { accesses: { some: { userId } } },
          { organization: { members: { some: { userId } } } },
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
          { organization: { members: { some: { userId, role: { in: ["OWNER", "PARTNER"] } } } } },
        ],
      },
      select: { id: true, userId: true },
    });
    if (!record) throw new HttpError("Case not found or not editable", 404);
    return record;
  }
}
