import JurisdictionModuleRepo from "../repositories/jurisdiction-module.repository";
import HttpError from "../utils/http-error";
import SecurityAuditSvc from "./security-audit.service";

const DEFAULTS = [
  { code: "PH", name: "Philippines", language: "en", enabled: true, configJson: { deadlineEngine: "ph-rules-of-court" } },
  { code: "SG", name: "Singapore", language: "en", enabled: false, configJson: { deadlineEngine: null } },
  { code: "US-NY", name: "New York, United States", language: "en", enabled: false, configJson: { deadlineEngine: null } },
  { code: "INT-ARB", name: "International Arbitration", language: "en", enabled: false, configJson: { deadlineEngine: null } },
];

export default class JurisdictionModuleSvc {
  static async list() {
    const existing = await JurisdictionModuleRepo.list();
    if (existing.length === 0) {
      for (const row of DEFAULTS) await JurisdictionModuleRepo.upsert(row);
      return JurisdictionModuleRepo.list();
    }
    return existing;
  }

  static async setEnabled(code: string, enabled: boolean) {
    const row = await JurisdictionModuleRepo.setEnabled(code, enabled);
    if (!row) throw new HttpError("Jurisdiction module not found", 404);
    // A platform-wide switch, so it belongs to no organization.
    await SecurityAuditSvc.record({
      action: "admin.jurisdiction_module.toggled",
      organizationId: null,
      targetType: "jurisdiction_module",
      targetId: code,
      payload: { enabled },
    });
    return row;
  }
}
