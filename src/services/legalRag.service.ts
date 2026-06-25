import LegalRagRepo, { DocumentFilter } from "../repositories/legalRag.repository";

export interface ListDocumentsParams extends DocumentFilter {
  keyword?: string;
}

export default class LegalRagSvc {
  static async listDocuments(params: ListDocumentsParams) {
    const { keyword, ...filter } = params;

    if (keyword) {
      return LegalRagRepo.searchDocumentsByKeyword(keyword, filter);
    }

    return LegalRagRepo.listDocuments(filter);
  }
}
