import type { LawyerVerificationStatus } from "@prisma/client";
import LawyerProfileRepo, { type LawyerProfileRow, type PhRegistrationFields, type UkRegistrationFields } from "../repositories/lawyer-profile.repository";
import HttpError from "../utils/http-error";
import { FEE_CURRENCY_BY_COUNTRY, isLawyerCountry, type LawyerCountry } from "../constants/lawyer-application.constants";

/** The registration part of a save, tagged with the country it's for. */
export type RegistrationPatch = ({ country: "UK" } & Partial<UkRegistrationFields>) | ({ country: "PH" } & Partial<PhRegistrationFields>);

/** What a lawyer can change. Verification and the organization's switch are set elsewhere. */
export interface LawyerProfilePatch {
  registration?: RegistrationPatch;
  practiceAreas?: string[];
  bio?: string;
  languages?: string[];
  firstConsultationFee?: { amountMinor: number; currency: string } | null;
  acceptingRequests?: boolean;
  pausedUntil?: Date | null;
  capacityLimit?: number | null;
}

type ProfileFields = Omit<LawyerProfileRow, "userId" | "createdAt" | "updatedAt">;

function empty(country: LawyerCountry): ProfileFields {
  return {
    country,
    regulator: null,
    registrationNumber: null,
    qualifiedJurisdictions: [],
    ph: { rollNumber: null, ibpChapter: null, ibpMembershipNumber: null, mcleNumber: null, mclePeriod: null },
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
}

const blank = (v: string | null) => !v?.trim();

/** What an admin needs before they can check the application. UK: what the regulator's register
 * is searched by. PH: the Roll of Attorneys number and IBP chapter (the rest is optional until the
 * PH rules are final). Both: at least one practice area. */
export function missingFields(p: Pick<ProfileFields, "country" | "regulator" | "registrationNumber" | "qualifiedJurisdictions" | "practiceAreas" | "ph">): string[] {
  const missing: string[] = [];
  if (p.country === "PH") {
    if (blank(p.ph.rollNumber)) missing.push("rollNumber");
    if (blank(p.ph.ibpChapter)) missing.push("ibpChapter");
  } else {
    if (!p.regulator) missing.push("regulator");
    if (blank(p.registrationNumber)) missing.push("registrationNumber");
    if (p.qualifiedJurisdictions.length === 0) missing.push("qualifiedJurisdictions");
  }
  if (p.practiceAreas.length === 0) missing.push("practiceAreas");
  return missing;
}

function sameSet(a: string[], b: string[]) {
  return a.length === b.length && a.every((x) => b.includes(x));
}

const same = (a: string | null, b: string | null) => (a ?? "").trim() === (b ?? "").trim();

/** Whether an edit changed what the admin checked. UK: regulator, number or jurisdictions. PH: the
 * Roll number or IBP chapter (membership and MCLE details are optional and don't count). */
function checkedFieldsChanged(before: ProfileFields, after: ProfileFields): boolean {
  if (after.country === "PH") return !same(before.ph.rollNumber, after.ph.rollNumber) || !same(before.ph.ibpChapter, after.ph.ibpChapter);
  return before.regulator !== after.regulator || !same(before.registrationNumber, after.registrationNumber) || !sameSet(before.qualifiedJurisdictions, after.qualifiedJurisdictions);
}

/**
 * Where verification goes after an edit. A complete application waits for an admin (PENDING).
 * Changing what the admin checked sends a VERIFIED or REJECTED one back to PENDING, since the check
 * no longer covers it. Other edits leave the status alone.
 */
export function nextVerificationStatus(before: ProfileFields, after: ProfileFields): LawyerVerificationStatus {
  if (missingFields(after).length > 0) return "UNSUBMITTED";
  if (before.verificationStatus === "UNSUBMITTED" || checkedFieldsChanged(before, after)) return "PENDING";
  return before.verificationStatus;
}

function registrationDto(p: ProfileFields) {
  if (p.country === "PH") return { country: "PH" as const, ...p.ph };
  return { country: "UK" as const, regulator: p.regulator, registrationNumber: p.registrationNumber, qualifiedJurisdictions: p.qualifiedJurisdictions };
}

export function toDto(p: ProfileFields) {
  const country = p.country as LawyerCountry;
  return {
    country,
    registration: registrationDto(p),
    practiceAreas: p.practiceAreas,
    bio: p.bio,
    languages: p.languages,
    firstConsultationFee: p.firstConsultationFeeMinor === null ? null : { amountMinor: p.firstConsultationFeeMinor, currency: FEE_CURRENCY_BY_COUNTRY[country] },
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

/** Folds a registration patch into the profile. A patch for the other country is refused: the
 * application's country is the lawyer's site, not something they choose. */
function applyRegistration(p: ProfileFields, patch: RegistrationPatch | undefined): ProfileFields {
  if (!patch) return p;
  if (patch.country !== p.country) {
    throw new HttpError(`This is a ${p.country} application; send ${p.country} registration details.`, 400, "WRONG_COUNTRY");
  }
  const { country: _country, ...fields } = patch;
  return patch.country === "PH" ? { ...p, ph: { ...p.ph, ...fields } } : { ...p, ...fields };
}

/**
 * A lawyer's Lawyer Application: their registration (per country), what they take on and what
 * clients see, and on the UK site whether they're accepting client requests now. An admin verifies
 * it (#506). UK matching (#509) uses it; on the PH site approval only shows a badge for now.
 */
export default class LawyerProfileSvc {
  static async get(userId: string) {
    const country = await LawyerProfileSvc.countryOf(userId);
    const row = await LawyerProfileRepo.find(userId);
    return toDto(row ?? empty(country));
  }

  static async update(userId: string, patch: LawyerProfilePatch) {
    const country = await LawyerProfileSvc.countryOf(userId);
    const before: ProfileFields = (await LawyerProfileRepo.find(userId)) ?? empty(country);
    const { registration, firstConsultationFee, ...rest } = patch;
    const after: ProfileFields = {
      ...applyRegistration(before, registration),
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
      if (patch.acceptingRequests && after.country !== "UK") {
        throw new HttpError("Client requests are only available on the UK site", 403, "NOT_UK_TENANT");
      }
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

  /** The country a lawyer applies in: their site. Only lawyers on a site with a Lawyer Application
   * (UK, PH) have one. A lawyer who already applied keeps the country they applied in. */
  static async countryOf(userId: string): Promise<LawyerCountry> {
    const who = await LawyerProfileRepo.findLawyerTenant(userId);
    if (!who || who.role !== "LAWYER") throw new HttpError("Lawyer applications are for lawyer accounts", 403, "NOT_A_LAWYER");
    const existing = await LawyerProfileRepo.find(userId);
    if (existing && isLawyerCountry(existing.country)) return existing.country;
    if (!isLawyerCountry(who.tenantCode)) throw new HttpError("Lawyer applications aren't available on this site", 403, "NOT_SUPPORTED_TENANT");
    return who.tenantCode;
  }
}
