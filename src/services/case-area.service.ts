import { Prisma, type CaseArea } from "@prisma/client";
import CaseAreaRepo from "../repositories/case-area.repository";
import SecurityAuditSvc from "./security-audit.service";
import HttpError from "../utils/http-error";
import type { LawyerCountry } from "../constants/lawyer-application.constants";
import type { SecurityAuditAction } from "../constants/security-audit.constants";
import { CASE_AREA_CODE_PATTERN, OTHER_CASE_AREA, PERSONAL_INJURY } from "../constants/case-area.constants";

/** Client cases are UK only for now, so every case's areas are the UK list's. */
export const CLIENT_CASE_COUNTRY: LawyerCountry = "UK";

export interface NewCaseArea {
  country: LawyerCountry;
  code: string;
  name: string;
  description: string;
}

export interface CaseAreaPatch {
  name?: string;
  description?: string;
  isActive?: boolean;
}

/** A case's areas as people read them: code and name, in the site's order. */
export interface CaseAreaRef {
  code: string;
  name: string;
}

const NAME_TAKEN = (country: string, name: string) => new HttpError(`${country} already has a case area called "${name}"`, 409, "CASE_AREA_NAME_TAKEN");
const CODE_TAKEN = (country: string, code: string) => new HttpError(`${country} already has a case area with code ${code}`, 409, "CASE_AREA_CODE_TAKEN");

function isUniqueViolation(err: unknown) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/**
 * The kinds of problem a client's case can be about (the client app's "Type of issue"), one list
 * per site, which admins manage. A case has one or more, picked by the client and replaced by Jev's
 * once the case is ready for a lawyer; matching sends it to lawyers whose practice areas map to any
 * of them. Cases and practice areas hold an area's `code`, so it's fixed once made. Switching an
 * area off hides it from the client's picker and from Jev; cases that have it keep it. OTHER is
 * where a case nothing else fits goes, so it stays on. Every admin change is in the security audit
 * log.
 */
export default class CaseAreaSvc {
  /** The client app's picker: the site's switched-on areas, in order. */
  static async listActive(country: LawyerCountry = CLIENT_CASE_COUNTRY): Promise<CaseAreaRef[]> {
    return (await CaseAreaRepo.list(country)).filter((a) => a.isActive).map(({ code, name }) => ({ code, name }));
  }

  /** What Jev chooses from: the site's switched-on areas with their descriptions. */
  static async forJev(country: LawyerCountry = CLIENT_CASE_COUNTRY) {
    return (await CaseAreaRepo.list(country)).filter((a) => a.isActive).map(({ code, name, description }) => ({ code, name, description }));
  }

  /** Names for codes, in the site's order. A code with no area (deleted since) shows as itself. */
  static async refsOf(codes: string[], country: LawyerCountry = CLIENT_CASE_COUNTRY): Promise<CaseAreaRef[]> {
    return (await CaseAreaSvc.labeller(country))(codes);
  }

  /** Loads the site's list once, for naming many cases' areas. */
  static async labeller(country: LawyerCountry = CLIENT_CASE_COUNTRY): Promise<(codes: string[]) => CaseAreaRef[]> {
    const areas = await CaseAreaRepo.list(country);
    const rank = new Map(areas.map((a, i) => [a.code, i]));
    const names = new Map(areas.map((a) => [a.code, a.name]));
    return (codes) =>
      [...new Set(codes)]
        .sort((a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity))
        .map((code) => ({ code, name: names.get(code) ?? code }));
  }

  /**
   * The areas a client saves on a case, checked against the site's list: at least one, each the
   * site's and switched on, except one the case already has, which it can keep after an admin
   * switches it off (the form sends back what it shows).
   */
  static async forCase(codes: string[], held: string[] = [], country: LawyerCountry = CLIENT_CASE_COUNTRY): Promise<string[]> {
    const unique = [...new Set(codes)];
    if (unique.length === 0) throw new HttpError("Pick at least one type of issue", 400, "CASE_AREA_REQUIRED");
    const areas = new Map((await CaseAreaRepo.list(country)).map((a) => [a.code, a]));
    const unknown = unique.filter((code) => !areas.has(code));
    if (unknown.length) throw new HttpError("Pick types of issue from the list", 400, "UNKNOWN_CASE_AREA", { codes: unknown });
    const inactive = unique.filter((code) => !areas.get(code)!.isActive && !held.includes(code));
    if (inactive.length) throw new HttpError("That type of issue is no longer offered", 400, "CASE_AREA_INACTIVE", { codes: inactive });
    return unique;
  }

  /** A practice area's mapping: one of the site's case areas, or null for none. */
  static async assertMappable(country: string, code: string | null | undefined) {
    if (!code) return;
    if (country !== CLIENT_CASE_COUNTRY) throw new HttpError("Only UK practice areas match client cases", 400, "CASE_AREA_UK_ONLY");
    if (!(await CaseAreaRepo.findByCode(CLIENT_CASE_COUNTRY, code))) throw new HttpError(`No case area with code ${code}`, 400, "UNKNOWN_CASE_AREA");
  }

  static async listForAdmin(country: LawyerCountry) {
    const areas = await CaseAreaRepo.list(country);
    const usage = await CaseAreaRepo.usage(areas.map((a) => a.code));
    return areas.map((a) => CaseAreaSvc.adminDto(a, usage.get(a.code)!));
  }

  static async create(input: NewCaseArea, adminId: string) {
    const code = input.code.trim().toUpperCase();
    const name = input.name.trim();
    const description = input.description.trim();
    if (!CASE_AREA_CODE_PATTERN.test(code)) throw new HttpError("A code is capital letters, digits or _, starting with a letter, 2 to 40 long", 400, "CASE_AREA_CODE_INVALID");
    if (code === PERSONAL_INJURY) throw new HttpError("Personal injury can't be a case area: referral fees are banned there", 400, "CASE_AREA_CODE_INVALID");
    if (await CaseAreaRepo.findByCode(input.country, code)) throw CODE_TAKEN(input.country, code);
    if (await CaseAreaRepo.findByName(input.country, name)) throw NAME_TAKEN(input.country, name);

    let row: CaseArea;
    try {
      row = await CaseAreaRepo.create({ country: input.country, code, name, description, sortOrder: (await CaseAreaRepo.maxSortOrder(input.country)) + 1 });
    } catch (err) {
      if (isUniqueViolation(err)) throw NAME_TAKEN(input.country, name);
      throw err;
    }
    await CaseAreaSvc.audit("admin.case_area.created", adminId, row, { to: { code, name, description } });
    return CaseAreaSvc.adminDto(row, { cases: 0, practiceAreas: 0 });
  }

  /** Rename, redescribe, or switch on/off. The code never changes. */
  static async update(id: string, patch: CaseAreaPatch, adminId: string) {
    const before = await CaseAreaRepo.find(id);
    if (!before) throw new HttpError("Unknown case area", 404);
    if (patch.isActive === false && before.code === OTHER_CASE_AREA) {
      throw new HttpError("Other can't be switched off: it's where a case nothing else fits goes", 409, "CASE_AREA_REQUIRED_OTHER");
    }
    const name = patch.name?.trim();
    const description = patch.description?.trim();
    if (name !== undefined && name.toLowerCase() !== before.name.toLowerCase()) {
      if (await CaseAreaRepo.findByName(before.country as LawyerCountry, name)) throw NAME_TAKEN(before.country, name);
    }

    let row: CaseArea;
    try {
      row = await CaseAreaRepo.update(id, { ...patch, name, description });
    } catch (err) {
      if (isUniqueViolation(err)) throw NAME_TAKEN(before.country, name!);
      throw err;
    }
    await CaseAreaSvc.audit("admin.case_area.updated", adminId, row, {
      from: { name: before.name, description: before.description, isActive: before.isActive },
      to: { ...patch, name, description },
    });
    return CaseAreaSvc.adminDto(row, (await CaseAreaRepo.usage([row.code])).get(row.code)!);
  }

  /** Only an area no case has and no practice area maps to; never OTHER. */
  static async delete(id: string, adminId: string) {
    const before = await CaseAreaRepo.find(id);
    if (!before) throw new HttpError("Unknown case area", 404);
    if (before.code === OTHER_CASE_AREA) throw new HttpError("Other can't be deleted: it's where a case nothing else fits goes", 409, "CASE_AREA_REQUIRED_OTHER");
    const usage = (await CaseAreaRepo.usage([before.code])).get(before.code)!;
    if (usage.cases > 0 || usage.practiceAreas > 0) {
      throw new HttpError("Cases or practice areas use this case area. Switch it off instead.", 409, "CASE_AREA_IN_USE", usage);
    }
    await CaseAreaRepo.delete(id);
    await CaseAreaSvc.audit("admin.case_area.deleted", adminId, before, { from: { code: before.code, name: before.name } });
  }

  /** `ids` is every area on the site, in the new order. */
  static async reorder(country: LawyerCountry, ids: string[], adminId: string) {
    const current = (await CaseAreaRepo.list(country)).map((a) => a.id);
    if (ids.length !== current.length || !current.every((id) => ids.includes(id))) {
      throw new HttpError(`Send every ${country} case area, each once`, 400, "CASE_AREA_ORDER_INCOMPLETE");
    }
    await CaseAreaRepo.reorder(ids);
    await SecurityAuditSvc.record({
      action: "admin.case_area.updated",
      actorId: adminId,
      organizationId: null,
      targetType: "case_area",
      targetId: country,
      payload: { to: { order: ids } },
    });
    return CaseAreaSvc.listForAdmin(country);
  }

  private static adminDto(area: CaseArea, usage: { cases: number; practiceAreas: number }) {
    return { ...area, caseCount: usage.cases, practiceAreaCount: usage.practiceAreas };
  }

  /** `targetId` is "<country>:<code>", e.g. "UK:EMPLOYMENT". */
  private static async audit(action: SecurityAuditAction, adminId: string, area: Pick<CaseArea, "country" | "code">, payload: Record<string, unknown>) {
    await SecurityAuditSvc.record({ action, actorId: adminId, organizationId: null, targetType: "case_area", targetId: `${area.country}:${area.code}`, payload });
  }
}
