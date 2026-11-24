import { ConsentPurpose } from "@prisma/client";
import ConsentRepo from "../repositories/consent.repository";
import HttpError from "../utils/http-error";
import SecurityAuditSvc from "./security-audit.service";
import GmailConnectionSvc from "./gmail-connection.service";
import DocumentExtractionQueue from "../queues/document-extraction.queue";
import logger from "../utils/logger";
import {
  ACTIVE_CONSENT_PURPOSES,
  CONSENT_VERSIONS,
  CONSENT_WHEN_UNANSWERED,
  ConsentSource,
  SELF_SERVICE_CONSENT_PURPOSES,
} from "../constants/consent.constants";
import { termsVersionFor } from "../constants/auth.constants";

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

  /** Whether the AI may read this person's case: their questions, documents and dictation. AI
   * processing must not be withdrawn and, for a client account, sensitive information must have been
   * agreed to as well (ilovelawyer-api#699): what a client describes often includes it. A lawyer
   * account is not asked. Every AI entry point checks this, the routes up front and the workers as
   * the backstop, so a job queued before a withdrawal doesn't run either. */
  static async mayRunAi(userId: string): Promise<boolean> {
    return (await ConsentSvc.missingForAi(userId)) === null;
  }

  /** 403 CONSENT_REQUIRED naming the purpose that is missing, so the client app knows whether to
   * point at the AI setting or show its sensitive-information step. */
  static async assertMayRunAi(userId: string): Promise<void> {
    const missing = await ConsentSvc.missingForAi(userId);
    if (missing === null) return;
    if (missing === "AI_PROCESSING") return ConsentSvc.assertAllowed(userId, missing);
    throw new HttpError(
      "Before the AI reads your case, you need to agree to how sensitive information is handled.",
      403,
      "CONSENT_REQUIRED",
      { purpose: missing },
    );
  }

  private static async missingForAi(userId: string): Promise<ConsentPurpose | null> {
    if (!(await ConsentSvc.isAllowed(userId, "AI_PROCESSING"))) return "AI_PROCESSING";
    if (await ConsentSvc.isAllowed(userId, "SENSITIVE_INFO")) return null;
    // Not agreed to: that only matters for a client account.
    return (await ConsentRepo.findRole(userId)) === "USER" ? "SENSITIVE_INFO" : null;
  }

  /** Every purpose, in the enum's order, so a client can render the full list without guessing
   * which ones exist. Terms of Service is read from the user row (set at signup). A purpose the
   * user has never answered is "not_set", which is not the same as "withdrawn". */
  static async list(userId: string): Promise<ConsentState[]> {
    const [rows, terms] = await Promise.all([ConsentRepo.findByUser(userId), ConsentRepo.findTerms(userId)]);
    const byPurpose = new Map(rows.map((row) => [row.purpose, row]));

    return ACTIVE_CONSENT_PURPOSES.map((purpose) => {
      const current = CONSENT_VERSIONS[purpose];

      if (purpose === "TERMS_OF_SERVICE") {
        if (!terms?.termsAcceptedAt) return { purpose, ...NOT_SET };
        return {
          purpose,
          status: "granted" as const,
          version: terms.termsVersion,
          grantedAt: terms.termsAcceptedAt,
          withdrawnAt: null,
          // A client account agrees to the client app's own Terms, versioned separately.
          outdated: terms.termsVersion !== termsVersionFor(terms.role),
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
  static async set(userId: string, purpose: ConsentPurpose, granted: boolean, source: ConsentSource = "settings") {
    if (!SELF_SERVICE_CONSENT_PURPOSES.includes(purpose)) {
      throw new HttpError(`${purpose} can't be changed here`, 400);
    }
    const version = CONSENT_VERSIONS[purpose]!;
    // Withdrawing email import stops it for good, not just for the next request: the Gmail grant
    // is revoked at Google and the stored tokens cleared (#989).
    if (purpose === "EMAIL_IMPORT" && !granted) await GmailConnectionSvc.disconnectIfConnected(userId);
    await ConsentRepo.set(userId, purpose, granted, version, source);
    // The consent table keeps only the latest answer per purpose; this is the history of changes.
    await SecurityAuditSvc.record({
      action: "consent.changed",
      actorId: userId,
      targetType: "user",
      targetId: userId,
      payload: { purpose, granted, version, source },
    });
    // Documents added while the AI couldn't read them were held back from indexing; index them now.
    if (granted && (purpose === "AI_PROCESSING" || purpose === "SENSITIVE_INFO")) await ConsentSvc.releaseHeldDocuments(userId);
    return ConsentSvc.list(userId);
  }

  private static async releaseHeldDocuments(userId: string): Promise<void> {
    try {
      if (!(await ConsentSvc.mayRunAi(userId))) return;
      const ids = await ConsentRepo.findPendingDocumentIds(userId);
      if (ids.length) DocumentExtractionQueue.enqueueMany(ids);
    } catch (err) {
      // The answer is saved either way; a document left waiting is picked up by the case's next refresh.
      logger.warn("Consent: couldn't queue documents held for consent", { err, userId });
    }
  }
}
