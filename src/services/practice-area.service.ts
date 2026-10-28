import { Prisma, type PracticeArea } from "@prisma/client";
import PracticeAreaRepo, { type PracticeAreaRef } from "../repositories/practice-area.repository";
import SecurityAuditSvc from "./security-audit.service";
import CaseAreaSvc from "./case-area.service";
import HttpError from "../utils/http-error";
import type { LawyerCountry } from "../constants/lawyer-application.constants";
import type { SecurityAuditAction } from "../constants/security-audit.constants";

export interface NewPracticeArea {
  country: LawyerCountry;
  name: string;
  caseArea?: string | null;
}

export interface PracticeAreaPatch {
  name?: string;
  caseArea?: string | null;
  isActive?: boolean;
}

const NAME_TAKEN = (country: string, name: string) => new HttpError(`${country} already has a practice area called "${name}"`, 409, "PRACTICE_AREA_NAME_TAKEN");
const IN_USE = () => new HttpError("Lawyers hold this practice area. Switch it off instead.", 409, "PRACTICE_AREA_IN_USE");

function isUniqueViolation(err: unknown) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

function isForeignKeyViolation(err: unknown) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003";
}


function adminDto(row: PracticeArea & { _count: { lawyers: number } }) {
  const { _count, ...area } = row;
  return { ...area, lawyerCount: _count.lawyers };
}

/**
 * The practice areas a lawyer lists on their Lawyer Application, one list per site, which admins
 * manage. An area a lawyer holds can be renamed or switched off (hidden from the picker and from
 * matching, still shown where it's held) but not deleted. A rename shows on every profile holding
 * the area at once and doesn't send anyone back for verification. Every admin change is recorded in
 * the security audit log: mapping (caseArea) or switching an area off changes who is routed client
 * requests.
 */
export default class PracticeAreaSvc {
  /** The picker: the site's active areas, in order. */
  static async listActive(country: LawyerCountry) {
    return PracticeAreaRepo.listActive(country);
  }

  static async listForAdmin(country: LawyerCountry) {
    return (await PracticeAreaRepo.listForAdmin(country)).map(adminDto);
  }

  static async create(input: NewPracticeArea, adminId: string) {
    const name = input.name.trim();
    const caseArea = input.caseArea ?? null;
    await CaseAreaSvc.assertMappable(input.country, caseArea);
    if (await PracticeAreaRepo.findByName(input.country, name)) throw NAME_TAKEN(input.country, name);

    let row: PracticeArea;
    try {
      row = await PracticeAreaRepo.create({ country: input.country, name, caseArea, sortOrder: (await PracticeAreaRepo.maxSortOrder(input.country)) + 1 });
    } catch (err) {
      if (isUniqueViolation(err)) throw NAME_TAKEN(input.country, name);
      throw err;
    }
    await PracticeAreaSvc.audit("admin.practice_area.created", adminId, row, { to: { name, caseArea } });
    return adminDto({ ...row, _count: { lawyers: 0 } });
  }

  static async update(id: string, patch: PracticeAreaPatch, adminId: string) {
    const before = await PracticeAreaRepo.find(id);
    if (!before) throw new HttpError("Unknown practice area", 404);
    const name = patch.name?.trim();
    await CaseAreaSvc.assertMappable(before.country, patch.caseArea);
    if (name !== undefined && name.toLowerCase() !== before.name.toLowerCase()) {
      if (await PracticeAreaRepo.findByName(before.country as LawyerCountry, name)) throw NAME_TAKEN(before.country, name);
    }

    let row: PracticeArea;
    try {
      row = await PracticeAreaRepo.update(id, { ...patch, name });
    } catch (err) {
      if (isUniqueViolation(err)) throw NAME_TAKEN(before.country, name!);
      throw err;
    }
    await PracticeAreaSvc.audit("admin.practice_area.updated", adminId, row, {
      from: { name: before.name, caseArea: before.caseArea, isActive: before.isActive },
      to: { ...patch, name },
    });
    return adminDto({ ...row, _count: before._count });
  }

  /** Only an area nobody holds; the foreign key backs this up if a lawyer picks it meanwhile. */
  static async delete(id: string, adminId: string) {
    const before = await PracticeAreaRepo.find(id);
    if (!before) throw new HttpError("Unknown practice area", 404);
    if (before._count.lawyers > 0) throw IN_USE();
    try {
      await PracticeAreaRepo.delete(id);
    } catch (err) {
      if (isForeignKeyViolation(err)) throw IN_USE();
      throw err;
    }
    await PracticeAreaSvc.audit("admin.practice_area.deleted", adminId, before, { from: { name: before.name, caseArea: before.caseArea } });
  }

  /** `ids` is every area on the site, in the new order. */
  static async reorder(country: LawyerCountry, ids: string[], adminId: string) {
    const current = await PracticeAreaRepo.listIds(country);
    if (ids.length !== current.length || !current.every((id) => ids.includes(id))) {
      throw new HttpError(`Send every ${country} practice area, each once`, 400, "PRACTICE_AREA_ORDER_INCOMPLETE");
    }
    await PracticeAreaRepo.reorder(ids);
    await SecurityAuditSvc.record({
      action: "admin.practice_area.updated",
      actorId: adminId,
      organizationId: null,
      targetType: "practice_area",
      targetId: country,
      payload: { to: { order: ids } },
    });
    return PracticeAreaSvc.listForAdmin(country);
  }

  /**
   * The areas a lawyer saves, checked against their site's list: each must be the site's and
   * switched on, except one they already hold, which they can keep after an admin switches it off
   * (their form sends back what it shows them).
   */
  static async forLawyer(country: LawyerCountry, ids: string[], held: PracticeAreaRef[]): Promise<PracticeAreaRef[]> {
    const rows = await PracticeAreaRepo.findByIds(ids);
    const unknown = ids.filter((id) => !rows.some((r) => r.id === id && r.country === country));
    if (unknown.length) throw new HttpError("Pick practice areas from your site's list", 400, "UNKNOWN_PRACTICE_AREA", { ids: unknown });
    const inactive = rows.filter((r) => !r.isActive && !held.some((h) => h.id === r.id));
    if (inactive.length) throw new HttpError("That practice area is no longer offered", 400, "PRACTICE_AREA_INACTIVE", { ids: inactive.map((r) => r.id) });
    return rows
      .map(({ id, name, caseArea, isActive, sortOrder }) => ({ id, name, caseArea, isActive, sortOrder }))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }

  /** `targetId` is "<country>:<name>", e.g. "UK:Employment Law", so the row still reads after a delete. */
  private static async audit(action: SecurityAuditAction, adminId: string, area: Pick<PracticeArea, "country" | "name">, payload: Record<string, unknown>) {
    await SecurityAuditSvc.record({ action, actorId: adminId, organizationId: null, targetType: "practice_area", targetId: `${area.country}:${area.name}`, payload });
  }
}
