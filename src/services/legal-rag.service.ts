import LegalRagRepo from "../repositories/legal-rag.repository";
import HttpError from "../utils/http-error";

export default class LegalRagSvc {
  static async list(page: number, limit: number, category?: string, year?: number, search?: string) {
    return LegalRagRepo.list({ page, limit, category, year, search });
  }

  static async getById(id: number) {
    const doc = await LegalRagRepo.findById(BigInt(id));
    if (!doc) throw new HttpError("Case law document not found", 404);
    return doc;
  }
}
