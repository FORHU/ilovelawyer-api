import { FindingCategory, FindingTag } from "@prisma/client";
import CaseFindingRepo, { FindingInput } from "../repositories/case-finding.repository";
import { isTagAllowed } from "../constants";
import CaseAccess from "../utils/case-access";
import HttpError from "../utils/http-error";
import OrganizationRepo from "../repositories/organization.repository";
import CaseGraphSvc from "./case-graph.service";

function assertTagFits(category: FindingCategory, tag: FindingTag | null | undefined) {
  if (tag && !isTagAllowed(category, tag)) throw new HttpError(`${tag} is not a valid tag for ${category}`, 400);
}

// Joi lets "" through for detail (same as notes) — store it as no detail rather than an empty line.
function normalize<T extends Partial<FindingInput>>(data: T): T {
  return data.detail === "" ? { ...data, detail: null } : data;
}

export default class CaseFindingSvc {
  static async list(caseId: string, userId: string, category?: FindingCategory) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    return CaseFindingRepo.list(caseId, category);
  }

  static async create(caseId: string, userId: string, data: FindingInput) {
    await CaseAccess.assertCanEdit(caseId, userId);
    assertTagFits(data.category, data.tag);
    const row = await CaseFindingRepo.create(caseId, normalize(data));
    await CaseGraphSvc.ensureNode(caseId, "FINDING", row.id);
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "finding.create", payload: { id: row.id, category: row.category } });
    return row;
  }

  static async update(caseId: string, id: string, userId: string, data: Partial<FindingInput>) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const existing = await CaseFindingRepo.find(id, caseId);
    if (!existing) throw new HttpError("Finding not found", 404);
    assertTagFits(existing.category, data.tag);
    const row = await CaseFindingRepo.update(id, caseId, normalize(data));
    if (!row) throw new HttpError("Finding not found", 404);
    await CaseGraphSvc.markStale(caseId, "FINDING", id, "Finding updated");
    await OrganizationRepo.writeAudit({ caseId, actorId: userId, action: "finding.update", payload: { id } });
    return row;
  }

  static async delete(caseId: string, id: string, userId: string) {
    await CaseAccess.assertCanEdit(caseId, userId);
    const deleted = await CaseFindingRepo.delete(id, caseId);
    if (!deleted) throw new HttpError("Finding not found", 404);
  }
}
