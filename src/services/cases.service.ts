import CasesRepo from "../repositories/cases.repository";
import HttpError from "../utils/http-error";

export default class CasesSvc {
  static async list(page: number, limit: number, category?: string, year?: number, search?: string) {
    return CasesRepo.list({ page, limit, category, year, search });
  }

  static async getById(id: number) {
    const doc = await CasesRepo.findById(BigInt(id));
    if (!doc) throw new HttpError("Case not found", 404);
    return doc;
  }
}
