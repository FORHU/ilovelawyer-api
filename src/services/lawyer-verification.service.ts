import crypto from "crypto";
import type { LawyerVerificationStatus } from "@prisma/client";
import LawyerProfileRepo, { type AdminLawyerProfileRow } from "../repositories/lawyer-profile.repository";
import AuthRepo from "../repositories/auth.repository";
import SecurityAuditSvc from "./security-audit.service";
import { toDto } from "./lawyer-profile.service";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";
import { sendEmail } from "../utils/mailer";
import { renderTemplate } from "../utils/template";
import { emailLinkOrigin } from "../utils/tenant-host";
import { LOGIN_LINK_EXPIRY_MS } from "../constants";
import PlanGateSvc from "./plan-gate.service";
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

/** The next step for a lawyer held by verify before plan (PlanGateSvc), who isn't in the app yet. */
const NEXT_STEP_CHOOSE_PLAN =
  "You can now choose your plan or start your free trial. Then turn on Accept client requests on your Profile page.";

const SIGNED_OUT_NOTE = "If you're signed out on this device, you'll sign in first and then go straight there.";
const LOGIN_LINK_NOTE = "This button signs you in. It works once and will expire in 7 days.";

/** The approval email's button, on the lawyer's own site. A lawyer held by verify before plan goes to
 * the plan step (/verification), where their onboarding carries on, through a one-time login link
 * like the account approval email's (AdminSvc.transition) — verify signs them out of the waiting
 * page. That needs an approved account (the link only signs in ACTIVE ones) and shares
 * User.loginLinkToken, so a link not clicked yet is reused rather than replaced. Everyone else, and a
 * held lawyer still waiting on account approval, gets a plain link: the app signs them in first if
 * needed. */
async function nextStepButton(
  user: { id: string; approvalStatus: string },
  country: LawyerCountry,
  choosesPlan: boolean,
): Promise<{ buttonLabel: string; buttonLink: string; linkNote: string }> {
  const origin = emailLinkOrigin(country, null);
  if (!choosesPlan) return { buttonLabel: "Go to your profile", buttonLink: `${origin}/homepage/profile`, linkNote: SIGNED_OUT_NOTE };
  if (user.approvalStatus !== "ACTIVE") return { buttonLabel: "Choose your plan", buttonLink: `${origin}/verification`, linkNote: SIGNED_OUT_NOTE };
  let token = await AuthRepo.findLiveLoginLinkToken(user.id);
  if (!token) {
    token = crypto.randomUUID();
    await AuthRepo.setLoginLinkToken(user.id, token, new Date(Date.now() + LOGIN_LINK_EXPIRY_MS));
  }
  return {
    buttonLabel: "Choose your plan",
    buttonLink: `${origin}/login-link?token=${token}&next=${encodeURIComponent("/verification")}`,
    linkNote: LOGIN_LINK_NOTE,
  };
}

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

  /** Emails the lawyer the decision. Non-fatal by design: the decision is already saved by then, and
   * a retry would hit assertPending, so a mail failure must not turn into an error for the admin.
   * Returns whether the email went out. */
  private static async notify(
    userId: string,
    template: string,
    subject: string,
    varsFor: (user: { id: string; approvalStatus: string }) => Record<string, string> | Promise<Record<string, string>>,
  ): Promise<boolean> {
    try {
      const user = await AuthRepo.findById(userId);
      if (!user) return false;
      const html = await renderTemplate(template, { name: user.name || "there", ...(await varsFor(user)) });
      await sendEmail({ to: user.email, subject, html });
      return true;
    } catch (err) {
      logger.error(`Failed to send ${template} email`, { err, userId });
      return false;
    }
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

    const choosesPlan = (await PlanGateSvc.stateOf(userId)) === "CHOOSE_PLAN";
    const sent = await LawyerVerificationSvc.notify(userId, "lawyer-verification-approved", "Your lawyer application has been approved", async (user) => ({
      nextStep: choosesPlan ? NEXT_STEP_CHOOSE_PLAN : NEXT_STEP[country],
      ...(await nextStepButton(user, country, choosesPlan)),
    }));
    // Signs a lawyer held by verify before plan out of the waiting page, same as account approval
    // (AdminSvc.transition): a refresh sends them to log in, or the email's login link signs them
    // straight into the plan step. Only once the email is out, so they're never signed out with
    // nothing telling them why.
    if (choosesPlan && sent) await AuthRepo.deleteSessionsByUserId(userId);

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

    await LawyerVerificationSvc.notify(userId, "lawyer-verification-rejected", "Your lawyer application wasn't approved", () => ({ reason: composedNote }));

    return toAdminRow(updated);
  }
}
