import CaseRepo from "../repositories/case.repository";
import HttpError from "../utils/http-error";

export default class CaseSvc {
  static async create(userId: string, caseName: string, partyInvolved?: string, notes?: string) {
    return CaseRepo.create(userId, caseName, partyInvolved, notes);
  }

  static async list(userId: string, page: number, limit: number) {
    return CaseRepo.list(userId, page, limit);
  }

  static async getById(id: string, userId: string) {
    const caseRecord = await CaseRepo.findById(id, userId);
    if (!caseRecord) throw new HttpError("Case not found", 404);
    return caseRecord;
  }

  static async update(id: string, userId: string, data: { caseName?: string; partyInvolved?: string; notes?: string }) {
    const updated = await CaseRepo.update(id, userId, data);
    if (!updated) throw new HttpError("Case not found", 404);
    return CaseRepo.findById(id, userId);
  }

  static async delete(id: string, userId: string) {
    const deleted = await CaseRepo.delete(id, userId);
    if (!deleted) throw new HttpError("Case not found", 404);
  }
}
