import type { LawyerVerificationStatus } from "@prisma/client";
import LawyerProfileRepo, { type AdminLawyerProfileRow } from "../repositories/lawyer-profile.repository";
import AuthRepo from "../repositories/auth.repository";
import SecurityAuditSvc from "./security-audit.service";
import { toDto } from "./lawyer-profile.service";
import HttpError from "../utils/http-error";
import { sendEmail } from "../utils/mailer";
import { renderTemplate } from "../utils/template";
import type { UkJurisdiction } from "../types/client-handoff";

export const LAWYER_REJECTION_REASONS = ["NAME_MISMATCH", "NOT_PRACTISING", "WRONG_JURISDICTION", "OTHER"] as const;
export type LawyerRejectionReason = (typeof LAWYER_REJECTION_REASONS)[number];

/** What the lawyer is told for each canned reason. OTHER has none — the admin's note is the
 * whole message. */
const REASON_TEXT: Record<Exclude<LawyerRejectionReason, "OTHER">, string> = {
  NAME_MISMATCH: "The name on your profile doesn't match the regulator's register.",
  NOT_PRACTISING: "The regulator's register doesn't show you as currently practising.",
  WRONG_JURISDICTION: "The jurisdiction you selected doesn't match the regulator's register.",
};

function composeNote(reason: LawyerRejectionReason, note: string | undefined): string {
  const trimmed = note?.trim();
  if (reason === "OTHER") return trimmed!;
  return trimmed ? `${REASON_TEXT[reason]} ${trimmed}` : REASON_TEXT[reason];
}

/** The AdminLawyerVerification schema in swagger-client-handoff.ts. No register check yet, so
 * registerCheck is always null — the admin checks the register by hand. */
export function toAdminRow(p: AdminLawyerProfileRow) {
  return {
    userId: p.userId,
    name: p.user.name || p.user.email,
    email: p.user.email,
    organizationName: p.user.organizationMemberships[0]?.organization.name ?? null,
    profile: toDto(p),
    registerCheck: null,
    submittedAt: p.submittedAt,
  };
}

/**
 * An admin's verify/reject decision on a lawyer's client-request profile (#506). No register
 * check yet — a business decision (2026-10-21) defers that; this just records the admin's
 * say-so. Matching (#509) only routes to a VERIFIED lawyer, already enforced by
 * LawyerProfileSvc.update.
 */
export default class LawyerVerificationSvc {
  private static async assertPending(userId: string, action: "verify" | "reject") {
    const profile = await LawyerProfileRepo.find(userId);
    if (!profile) throw new HttpError("Lawyer profile not found", 404);
    if (profile.verificationStatus !== "PENDING") {
      throw new HttpError(`Cannot ${action}: profile is ${profile.verificationStatus}, not PENDING`, 409);
    }
    return profile;
  }

  private static async notify(userId: string, template: string, subject: string, reason?: string) {
    const user = await AuthRepo.findById(userId);
    if (!user) return;
    const html = await renderTemplate(template, { name: user.name || "there", reason: reason ?? "" });
    await sendEmail({ to: user.email, subject, html });
  }

  /** The admin queue for one status, oldest submission first. */
  static async list(params: { status: LawyerVerificationStatus; page: number; limit: number }) {
    const { data, total } = await LawyerProfileRepo.listForAdmin(params);
    return { data: data.map(toAdminRow), total };
  }

  /** The admin confirms which jurisdictions the lawyer is qualified in; that replaces what the
   * lawyer claimed. The note is for other admins, so it goes in the audit trail — not in
   * verificationNote, which the lawyer's own profile shows them. */
  static async verify(
    userId: string,
    { confirmedJurisdictions, note }: { confirmedJurisdictions: UkJurisdiction[]; note?: string },
    adminId: string
  ) {
    await LawyerVerificationSvc.assertPending(userId, "verify");

    const updated = await LawyerProfileRepo.setVerification(userId, {
      verificationStatus: "VERIFIED",
      verificationNote: null,
      verifiedAt: new Date(),
      qualifiedJurisdictions: confirmedJurisdictions,
    });

    const trimmedNote = note?.trim();
    await SecurityAuditSvc.record({
      action: "admin.lawyer.verified",
      actorId: adminId,
      targetType: "user",
      targetId: userId,
      payload: { from: "PENDING", to: "VERIFIED", confirmedJurisdictions, ...(trimmedNote ? { note: trimmedNote } : {}) },
    });

    await LawyerVerificationSvc.notify(userId, "lawyer-verification-approved", "Your SRA registration has been verified");

    return toAdminRow(updated);
  }

  static async reject(userId: string, reason: LawyerRejectionReason, note: string | undefined, adminId: string) {
    await LawyerVerificationSvc.assertPending(userId, "reject");
    const composedNote = composeNote(reason, note);

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

    await LawyerVerificationSvc.notify(userId, "lawyer-verification-rejected", "Your SRA registration could not be verified", composedNote);

    return toAdminRow(updated);
  }
}
