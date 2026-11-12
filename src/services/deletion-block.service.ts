import SupportActionRepo from "../repositories/support-action.repository";
import { shownStatus } from "../utils/client-request-status";
import HttpError from "../utils/http-error";

/** What the client has to do about a blocking request before the account can go. */
export type DeletionBlockAction =
  /** Take it back: POST /client/lawyer-requests/:id/withdraw. */
  | "WITHDRAW"
  /** End the engagement: POST /client/lawyer-requests/:id/end. */
  | "END"
  /** The quote is accepted and waiting on payment: there is nothing to withdraw or end yet. Open the
   * request to pay it, or let the quote lapse. */
  | "REVIEW";

export interface OpenLawyerRequest {
  id: string;
  caseId: string;
  caseTitle: string;
  status: string;
  action: DeletionBlockAction;
}

/** A client account can't be deleted while one of its lawyer requests is open or engaged
 * (DELETION_BLOCKING_REQUEST_STATUSES): a lawyer may still be working on it, or hold access to the
 * client's case. Withdrawing and ending keep their own refund and audit rules. Lawyer accounts aren't
 * checked. */
export default class DeletionBlockSvc {
  static async openLawyerRequests(clientId: string): Promise<OpenLawyerRequest[]> {
    const rows = await SupportActionRepo.deletionBlockingRequests(clientId);
    return rows.map((row) => ({
      id: row.id,
      caseId: row.caseId,
      caseTitle: row.case.caseName,
      status: shownStatus(row.status, row.claims),
      action: row.status === "ENGAGED" ? "END" : row.status === "CONFIRMED" ? "REVIEW" : "WITHDRAW",
    }));
  }

  /** 409 OPEN_LAWYER_REQUESTS, with the requests, if any block. */
  static async assertNoneOpen(clientId: string): Promise<void> {
    const requests = await DeletionBlockSvc.openLawyerRequests(clientId);
    if (requests.length > 0) {
      throw new HttpError("Withdraw or end your open lawyer requests before deleting your account.", 409, "OPEN_LAWYER_REQUESTS", { requests });
    }
  }
}
