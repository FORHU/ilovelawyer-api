import { ConsentPurpose } from "@prisma/client";
import ConsentRepo from "../repositories/consent.repository";
import HttpError from "../utils/http-error";
import SecurityAuditSvc from "./security-audit.service";
import { CONSENT_VERSIONS, CONSENT_WHEN_UNANSWERED, SELF_SERVICE_CONSENT_PURPOSES } from "../constants/consent.constants";

export type ConsentStatus = "granted" | "withdrawn" | "not_set";

export interface ConsentState {
  purpose: ConsentPurpose;
  status: ConsentStatus;
  /** Version of the policy text the user answered for; null when not set. */
  version: string | null;
  grantedAt: Date | null;
  withdrawnAt: Date | null;
  /** True when the user answered for an older version than the current text. */
  outdated: boolean;
}

const NOT_SET = { status: "not_set" as const, version: null, grantedAt: null, withdrawnAt: null, outdated: false };

export default class ConsentSvc {
  /** Whether something that needs `purpose` may go ahead for this person. A granted answer allows
   * it, a withdrawn one blocks it, and no answer follows CONSENT_WHEN_UNANSWERED. A withdrawal is
   * honoured even if the answer was given to an older version of the text. */
  static async isAllowed(userId: string, purpose: ConsentPurpose): Promise<boolean> {
    if (purpose === "TERMS_OF_SERVICE") return true;
    const row = await ConsentRepo.find(userId, purpose);
    if (!row) return CONSENT_WHEN_UNANSWERED[purpose] === "allowed";
    return !row.withdrawnAt;
  }

  /** 403 with code CONSENT_REQUIRED when `isAllowed` says no, so a client can tell it apart from a
   * permissions error and point the person at their consent settings. */
  static async assertAllowed(userId: string, purpose: ConsentPurpose): Promise<void> {
    if (await ConsentSvc.isAllowed(userId, purpose)) return;
    throw new HttpError(
      "This needs your consent, which is switched off. You can change it in your account settings.",
      403,
      "CONSENT_REQUIRED",
      { purpose },
    );
  }

  /** Every purpose, in the enum's order, so a client can render the full list without guessing
   * which ones exist. Terms of Service is read from the user row (set at signup). A purpose the
   * user has never answered is "not_set", which is not the same as "withdrawn". */
  static async list(userId: string): Promise<ConsentState[]> {
    const [rows, terms] = await Promise.all([ConsentRepo.findByUser(userId), ConsentRepo.findTerms(userId)]);
    const byPurpose = new Map(rows.map((row) => [row.purpose, row]));

    return (Object.keys(CONSENT_VERSIONS) as ConsentPurpose[]).map((purpose) => {
      const current = CONSENT_VERSIONS[purpose];

      if (purpose === "TERMS_OF_SERVICE") {
        if (!terms?.termsAcceptedAt) return { purpose, ...NOT_SET };
        return {
          purpose,
          status: "granted" as const,
          version: terms.termsVersion,
          grantedAt: terms.termsAcceptedAt,
          withdrawnAt: null,
          outdated: terms.termsVersion !== current,
        };
      }

      const row = byPurpose.get(purpose);
      if (!row) return { purpose, ...NOT_SET };
      return {
        purpose,
        status: row.withdrawnAt ? ("withdrawn" as const) : ("granted" as const),
        version: row.version,
        grantedAt: row.grantedAt,
        withdrawnAt: row.withdrawnAt,
        outdated: !row.withdrawnAt && row.version !== current,
      };
    });
  }

  /** Grants or withdraws one purpose and returns the new state of the whole list. Terms of
   * Service can't be changed here. */
  static async set(userId: string, purpose: ConsentPurpose, granted: boolean) {
    if (!SELF_SERVICE_CONSENT_PURPOSES.includes(purpose)) {
      throw new HttpError(`${purpose} can't be changed here`, 400);
    }
    await ConsentRepo.set(userId, purpose, granted, CONSENT_VERSIONS[purpose], "settings");
    // The consent table keeps only the latest answer per purpose; this is the history of changes.
    await SecurityAuditSvc.record({
      action: "consent.changed",
      actorId: userId,
      targetType: "user",
      targetId: userId,
      payload: { purpose, granted, version: CONSENT_VERSIONS[purpose] },
    });
    return ConsentSvc.list(userId);
  }
}
