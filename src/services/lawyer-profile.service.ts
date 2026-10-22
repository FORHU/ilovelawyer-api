import type { LawyerClientProfile, LawyerVerificationStatus } from "@prisma/client";
import LawyerProfileRepo from "../repositories/lawyer-profile.repository";
import HttpError from "../utils/http-error";

/** What a lawyer can change. Verification and the organization's switch are set elsewhere. */
export interface LawyerProfilePatch {
  regulator?: string | null;
  registrationNumber?: string | null;
  qualifiedJurisdictions?: string[];
  practiceAreas?: string[];
  bio?: string;
  languages?: string[];
  firstConsultationFee?: { amountMinor: number; currency: "GBP" } | null;
  acceptingRequests?: boolean;
  pausedUntil?: Date | null;
  capacityLimit?: number | null;
}

type ProfileFields = Omit<LawyerClientProfile, "userId" | "createdAt" | "updatedAt">;

const EMPTY: ProfileFields = {
  regulator: null,
  registrationNumber: null,
  qualifiedJurisdictions: [],
  practiceAreas: [],
  bio: "",
  languages: [],
  firstConsultationFeeMinor: null,
  acceptingRequests: false,
  enabledByOrganization: true,
  pausedUntil: null,
  capacityLimit: null,
  verificationStatus: "UNSUBMITTED",
  verificationNote: null,
  verifiedAt: null,
  submittedAt: null,
};

/** What an admin needs before they can check the lawyer against the regulator's register. */
export function missingFields(p: Pick<ProfileFields, "regulator" | "registrationNumber" | "qualifiedJurisdictions" | "practiceAreas">): string[] {
  const missing: string[] = [];
  if (!p.regulator) missing.push("regulator");
  if (!p.registrationNumber?.trim()) missing.push("registrationNumber");
  if (p.qualifiedJurisdictions.length === 0) missing.push("qualifiedJurisdictions");
  if (p.practiceAreas.length === 0) missing.push("practiceAreas");
  return missing;
}

function sameSet(a: string[], b: string[]) {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/**
 * Where verification goes after an edit. A complete profile waits for an admin (PENDING). Changing
 * what the admin checked (who regulates them, their number, where they're qualified) sends a
 * VERIFIED or REJECTED profile back to PENDING, since the register check no longer covers it. Other
 * edits leave the status alone.
 */
export function nextVerificationStatus(before: ProfileFields, after: ProfileFields): LawyerVerificationStatus {
  if (missingFields(after).length > 0) return "UNSUBMITTED";
  const checkedFieldsChanged =
    before.regulator !== after.regulator ||
    (before.registrationNumber ?? "").trim() !== (after.registrationNumber ?? "").trim() ||
    !sameSet(before.qualifiedJurisdictions, after.qualifiedJurisdictions);
  if (before.verificationStatus === "UNSUBMITTED" || checkedFieldsChanged) return "PENDING";
  return before.verificationStatus;
}

export function toDto(p: ProfileFields) {
  return {
    regulator: p.regulator,
    registrationNumber: p.registrationNumber,
    qualifiedJurisdictions: p.qualifiedJurisdictions,
    practiceAreas: p.practiceAreas,
    bio: p.bio,
    languages: p.languages,
    firstConsultationFee: p.firstConsultationFeeMinor === null ? null : { amountMinor: p.firstConsultationFeeMinor, currency: "GBP" as const },
    acceptingRequests: p.acceptingRequests,
    enabledByOrganization: p.enabledByOrganization,
    pausedUntil: p.pausedUntil,
    capacityLimit: p.capacityLimit,
    // Engagements don't exist yet (#514); matching will count them against capacityLimit.
    openEngagements: 0,
    verification: { status: p.verificationStatus, note: p.verificationNote, verifiedAt: p.verifiedAt },
    missing: missingFields(p),
  };
}

/**
 * A lawyer's settings for receiving client requests (UK only): who regulates them and their
 * number, where they're qualified, what they take on, and whether they're accepting requests now.
 * Matching (#509) uses it; an admin verifies it against the regulator's register (#506).
 */
export default class LawyerProfileSvc {
  static async get(userId: string) {
    await LawyerProfileSvc.assertUkLawyer(userId);
    const row = await LawyerProfileRepo.find(userId);
    return toDto(row ?? EMPTY);
  }

  static async update(userId: string, patch: LawyerProfilePatch) {
    await LawyerProfileSvc.assertUkLawyer(userId);
    const before: ProfileFields = (await LawyerProfileRepo.find(userId)) ?? EMPTY;
    const { firstConsultationFee, ...rest } = patch;
    const after: ProfileFields = {
      ...before,
      ...rest,
      ...(firstConsultationFee !== undefined ? { firstConsultationFeeMinor: firstConsultationFee?.amountMinor ?? null } : {}),
    };
    after.verificationStatus = nextVerificationStatus(before, after);
    if (after.verificationStatus !== before.verificationStatus) {
      after.verifiedAt = after.verificationStatus === "VERIFIED" ? before.verifiedAt : null;
      // Joining (or rejoining) the admin queue: a fresh date, so a resubmission isn't ranked by
      // the first attempt.
      if (after.verificationStatus === "PENDING") {
        after.verificationNote = null;
        after.submittedAt = new Date();
      }
    }

    // Only an explicit switch-on is refused. A lawyer who was already accepting and then clears a
    // required field, or changes what was verified, is switched off instead, so the edit still saves.
    if (after.acceptingRequests) {
      const missing = missingFields(after);
      if (patch.acceptingRequests && missing.length) {
        throw new HttpError("Finish your profile before accepting client requests.", 422, "PROFILE_INCOMPLETE", { missing });
      }
      if (patch.acceptingRequests && after.verificationStatus !== "VERIFIED") {
        throw new HttpError("You can accept client requests once we've verified your registration.", 403, "LAWYER_NOT_VERIFIED");
      }
      if (missing.length || after.verificationStatus !== "VERIFIED") after.acceptingRequests = false;
    }

    const saved = await LawyerProfileRepo.upsert(userId, after);
    return toDto(saved);
  }

  /** Client requests are UK only, and for lawyers. */
  private static async assertUkLawyer(userId: string) {
    const who = await LawyerProfileRepo.findLawyerTenant(userId);
    if (!who || who.role !== "LAWYER") throw new HttpError("Client requests are for lawyer accounts", 403, "NOT_A_LAWYER");
    if (who.tenantCode !== "UK") throw new HttpError("Client requests are only available on the UK site", 403, "NOT_UK_TENANT");
  }
}
