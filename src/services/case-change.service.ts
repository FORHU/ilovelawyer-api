import CaseAccess from "../utils/case-access";
import CaseChangeSummaryRepo from "../repositories/case-change-summary.repository";
import { CASE_CHANGE_SUMMARY_LIST_LIMIT } from "../constants";

export default class CaseChangeSvc {
  /** Newest first. Anyone who can open the case can read them — they describe the case's shared
   * analysis, the same panes every viewer of the Terminal reads. */
  static async list(caseId: string, userId: string, limit = CASE_CHANGE_SUMMARY_LIST_LIMIT) {
    await CaseAccess.loadAccessibleCase(caseId, userId);
    return CaseChangeSummaryRepo.list(caseId, Math.min(Math.max(1, limit), CASE_CHANGE_SUMMARY_LIST_LIMIT));
  }
}
