import CaseRepo, { CaseData } from "../repositories/case.repository";
import HttpError from "../utils/http-error";

interface CaseWithParties {
  caseName: string;
  actionType?: string | null;
  jurisdiction?: string | null;
  partyInvolved?: string | null;
  notes?: string | null;
  parties?: { name: string; designation: string }[];
}

export default class CaseSvc {
  static async create(userId: string, data: CaseData & { caseName: string }) {
    return CaseRepo.create(userId, data);
  }

  static async list(userId: string, page: number, limit: number, search?: string) {
    return CaseRepo.list(userId, page, limit, search);
  }

  static async getById(id: string, userId: string) {
    const caseRecord = await CaseRepo.findById(id, userId);
    if (!caseRecord) throw new HttpError("Case not found", 404);
    return caseRecord;
  }

  static async update(id: string, userId: string, data: CaseData) {
    const updated = await CaseRepo.update(id, userId, data);
    if (!updated) throw new HttpError("Case not found", 404);
    return CaseRepo.findById(id, userId);
  }

  static async delete(id: string, userId: string) {
    const deleted = await CaseRepo.delete(id, userId);
    if (!deleted) throw new HttpError("Case not found", 404);
  }

  /**
   * Formats a Case's structured fields as plain text so the AI has the case's
   * details without the user re-explaining them each message. Re-run per message
   * (not cached) so edits to the Case are reflected immediately, never stale.
   */
  static formatForAiContext(caseRecord: CaseWithParties): string {
    const lines: string[] = [`Case: ${caseRecord.caseName}`];

    if (caseRecord.actionType) lines.push(`Type of Action: ${caseRecord.actionType}`);
    if (caseRecord.jurisdiction) lines.push(`Jurisdiction: ${caseRecord.jurisdiction}`);

    if (caseRecord.parties && caseRecord.parties.length > 0) {
      lines.push("Parties:");
      for (const party of caseRecord.parties) {
        lines.push(`- ${party.name} (${party.designation})`);
      }
    } else if (caseRecord.partyInvolved) {
      lines.push(`Parties: ${caseRecord.partyInvolved}`);
    }

    if (caseRecord.notes) lines.push(`Notes: ${caseRecord.notes}`);

    return lines.join("\n");
  }
}
