import type { LawyerVerificationStatus } from "@prisma/client";
import LawyerProfileRepo, { type AdminLawyerProfileRow } from "../repositories/lawyer-profile.repository";
import AuthRepo from "../repositories/auth.repository";
import SecurityAuditSvc from "./security-audit.service";
import { toDto } from "./lawyer-profile.service";
import HttpError from "../utils/http-error";
import { sendEmail } from "../utils/mailer";
import { renderTemplate } from "../utils/template";
import type { UkJurisdiction } from "../types/client-handoff";
import {
  REJECTION_REASONS_BY_COUNTRY,
  type LawyerCountry,
  type LawyerRejectionReason,
} from "../constants/lawyer-application.constants";

export { LAWYER_REJECTION_REASONS, type LawyerRejectionReason } from "../constants/lawyer-application.constants";

/** What the lawyer is told for each canned reason, per country. OTHER has none — the admin's note
 * is the whole message. */
const REASON_TEXT: Record<LawyerCountry, Partial<Record<LawyerRejectionReason, string>>> = {
  UK: {
    NAME_MISMATCH: "The name on your profile doesn't match the regulator's register.",
    NOT_PRACTISING: "The regulator's register doesn't show you as currently practising.",
    WRONG_JURISDICTION: "The jurisdiction you selected doesn't match the regulator's register.",
  },
  PH: {
    NAME_MISMATCH: "The name on your profile doesn't match the Roll of Attorneys.",
    ROLL_NOT_FOUND: "We couldn't find your Roll of Attorneys number.",
    NOT_IN_GOOD_STANDING: "The IBP doesn't show you as a member in good standing.",
  },
};

/** What approval lets the lawyer do next, for the approval email. */
const NEXT_STEP: Record<LawyerCountry, string> = {
  UK: "You can now turn on Accept client requests on your Profile page.",
  PH: "Your profile now shows an Approved badge.",
};

function composeNote(country: LawyerCountry, reason: LawyerRejectionReason, note: string | undefined): string {
  const trimmed = note?.trim();
  const canned = reason === "OTHER" ? undefined : REASON_TEXT[country][reason];
  if (!canned) return trimmed!;
  return trimmed ? `${canned} ${trimmed}` : canned;
}

/** The AdminLawyerVerification schema in swagger-client-handoff.ts. No register check yet, so
 * registerCheck is always null — the admin checks the register by hand. `firm` is the lawyer's
 * organization's details, or null for a solo practitioner's personal workspace. */
export function toAdminRow(p: AdminLawyerProfileRow) {
  const org = p.user.organizationMemberships[0]?.organization ?? null;
  return {
    userId: p.userId,
    name: p.user.name || p.user.email,
    email: p.user.email,
    organizationName: org && !org.isPersonal ? org.name : null,
    firm:
      org && !org.isPersonal
        ? {
            name: org.name,
            regulator: org.firmRegulator,
            registrationNumber: org.firmRegistrationNumber,
            phone: org.phone,
            address: { line1: org.addressLine1, line2: org.addressLine2, city: org.city, postcode: org.postcode },
          }
        : null,
    profile: toDto(p),
    registerCheck: null,
    submittedAt: p.submittedAt,
  };
}

/**
 * An admin's approve/reject decision on a Lawyer Application (#506). No register check yet — a
 * business decision (2026-10-21) defers that; this records the admin's say-so. UK matching (#509)
 * only routes to a VERIFIED lawyer, already enforced by LawyerProfileSvc.update.
 */
export default class LawyerVerificationSvc {
  private static async assertPending(userId: string, action: "verify" | "reject") {
    const profile = await LawyerProfileRepo.find(userId);
    if (!profile) throw new HttpError("Lawyer profile not found", 404);
    if (profile.verificationStatus !== "PENDING") {
      throw new HttpError(`Cannot ${action}: profile is ${profile.verificationStatus}, not PENDING`, 409);
    }
    return { ...profile, country: profile.country as LawyerCountry };
  }

  private static async notify(userId: string, template: string, subject: string, vars: Record<string, string>) {
    const user = await AuthRepo.findById(userId);
    if (!user) return;
    const html = await renderTemplate(template, { name: user.name || "there", ...vars });
    await sendEmail({ to: user.email, subject, html });
  }

  /** The admin queue for one site and status, oldest submission first. */
  static async list(params: { country: LawyerCountry; status: LawyerVerificationStatus; page: number; limit: number }) {
    const { data, total } = await LawyerProfileRepo.listForAdmin(params);
    return { data: data.map(toAdminRow), total };
  }

  /** UK: the admin confirms which jurisdictions the lawyer is qualified in; that replaces what the
   * lawyer claimed. PH has no jurisdictions to confirm. The note is for other admins, so it goes in
   * the audit trail — not in verificationNote, which the lawyer's own profile shows them. */
  static async verify(
    userId: string,
    { confirmedJurisdictions, note }: { confirmedJurisdictions?: UkJurisdiction[]; note?: string },
    adminId: string
  ) {
    const { country } = await LawyerVerificationSvc.assertPending(userId, "verify");
    if (country === "UK" && !confirmedJurisdictions?.length) {
      throw new HttpError("Confirm at least one jurisdiction", 400);
    }
    const confirmed = country === "UK" ? confirmedJurisdictions : undefined;

    const verifiedAt = new Date();
    const updated = await LawyerProfileRepo.setVerification(userId, { verificationStatus: "VERIFIED", verificationNote: null, verifiedAt }, confirmed);
    // Lets a lawyer held by verify before plan in, for good: a later edit back to PENDING doesn't
    // take it away.
    await LawyerProfileRepo.markFirstVerified(userId, verifiedAt);

    const trimmedNote = note?.trim();
    await SecurityAuditSvc.record({
      action: "admin.lawyer.verified",
      actorId: adminId,
      targetType: "user",
      targetId: userId,
      payload: { from: "PENDING", to: "VERIFIED", ...(confirmed ? { confirmedJurisdictions: confirmed } : {}), ...(trimmedNote ? { note: trimmedNote } : {}) },
    });

    await LawyerVerificationSvc.notify(userId, "lawyer-verification-approved", "Your lawyer application has been approved", { nextStep: NEXT_STEP[country] });

    return toAdminRow(updated);
  }

  static async reject(userId: string, reason: LawyerRejectionReason, note: string | undefined, adminId: string) {
    const { country } = await LawyerVerificationSvc.assertPending(userId, "reject");
    if (!REJECTION_REASONS_BY_COUNTRY[country].includes(reason)) {
      throw new HttpError(`${reason} isn't a reason for a ${country} application`, 400);
    }
    const composedNote = composeNote(country, reason, note);

    const updated = await LawyerProfileRepo.setVerification(userId, {
      verificationStatus: "REJECTED",
      verificationNote: composedNote,
      verifiedAt: null,
    });

    await SecurityAuditSvc.record({
      action: "admin.lawyer.rejected",
      actorId: adminId,
      targetType: "user",
      targetId: userId,
      payload: { from: "PENDING", to: "REJECTED", reason },
    });

    await LawyerVerificationSvc.notify(userId, "lawyer-verification-rejected", "Your lawyer application wasn't approved", { reason: composedNote });

    return toAdminRow(updated);
  }
}
