import bcrypt from "bcrypt";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { Prisma } from "@prisma/client";
import AuthRepo from "../repositories/auth.repository";
import OrganizationMemberRepo from "../repositories/organization-member.repository";
import TenantRepo from "../repositories/tenant.repository";
import TenantSettingSvc from "./tenant-setting.service";
import loginToken from "../utils/loginToken";
import AvatarSvc from "./avatar.service";
import AccountDeletionSvc from "./account-deletion.service";
import SecurityAuditSvc from "./security-audit.service";
import AuditSvc, { AuditAction } from "./audit.service";
import GoogleCalendarSvc from "./google-calendar.service";
import verifyGoogleToken from "../utils/googleToken";
import HttpError from "../utils/http-error";
import { sendEmail } from "../utils/mailer";
import { renderTemplate } from "../utils/template";
import logger from "../utils/logger";
import type { TenantCode } from "../types/tenant-code";
import { REFRESH_TOKEN_SECRET, REFRESH_TOKEN_EXPIRY_DAYS } from "../config";
import { emailLinkOrigin } from "../utils/tenant-host";
import {
  BCRYPT_SALT_ROUNDS,
  OTP_EXPIRY_MS,
  EMAIL_VERIFICATION_EXPIRY_MS,
  EMAIL_VERIFICATION_RESEND_COOLDOWN_MS,
  EMAIL_VERIFICATION_MAX_ATTEMPTS,
  TERMS_VERSION,
  GOOGLE_PHOTO_SIGNUP_WAIT_MS,
} from "../constants";
import { generateOtpCode, duplicateEmailMessage, isGoogleSsoAccount, isUniqueViolation, normalizeEmail } from "../utils/auth.utils";

export default class AuthSvc {
  static async signup(
    username: string,
    email: string,
    password: string,
    name: string,
    requestTenantCode: TenantCode | null = null,
    acceptedTerms = false,
  ) {
    email = normalizeEmail(email);

    const existingUser = await AuthRepo.findByEmail(email);
    if (existingUser) {
      throw new HttpError(duplicateEmailMessage(existingUser, "Email already in use", requestTenantCode), 409);
    }

    const existingUsername = await AuthRepo.findByUsername(username);
    if (existingUsername) {
      throw new HttpError("Username already in use", 409);
    }

    const hashedPassword = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);

    // Unlike Organization creation, an unresolved origin (local dev, direct API calls)
    // never blocks signup — the account is just created without a Tenant link, same as
    // login/refresh's existing "let it through" handling of an unresolved Tenant code.
    const tenantId = requestTenantCode ? await TenantRepo.findIdByCode(requestTenantCode) : null;

    let user;
    try {
      // acceptedTerms is optional on the wire for now (signupSchema) so an app build that
      // predates it can still sign up — the frontend already gates signup on the Terms dialog.
      // Recorded whenever it's sent; make it required once every client sends it.
      user = await AuthRepo.createUser({
        username,
        email,
        password: hashedPassword,
        name,
        tenantId,
        termsVersion: acceptedTerms ? TERMS_VERSION : null,
      });
    } catch (err) {
      // The findByEmail/findByUsername checks above aren't atomic with this insert — a
      // concurrent signup for the same email (a double-submit, or a retry racing the request
      // that created the row in the first place) can slip past both and hit the unique
      // constraint here instead. Without this, that's an uncaught PrismaClientKnownRequestError,
      // which error-handler.middleware.ts has no special case for and turns into a bare 500 —
      // this makes it the same clean 409 the pre-check above already gives a non-racing caller.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new HttpError("Email already in use", 409);
      }
      throw err;
    }

    // Sent immediately, before email verification — the user should know to expect the
    // wait from the very start. approvalStatus defaults to PENDING (see schema.prisma).
    // Skipped when the Tenant auto-approves signups: there's no wait, and verifyOtp flips
    // the account to ACTIVE (see autoApproveIfEnabled).
    if (!(await TenantSettingSvc.isAutoApproveOn(tenantId))) {
      await AuthSvc.sendSignupPendingEmail(user);
    }

    await SecurityAuditSvc.record({ action: "auth.signup", actorId: user.id, payload: { method: "password" } });
    return user;
  }

  /** Non-fatal by design: the account row already exists by the time this runs, so letting a
   * mail failure turn into a 500 would leave the client with no session (Google) or a retry
   * that 409s "Email already in use" (password) for an account that was actually created. */
  private static async sendSignupPendingEmail(user: { id: string; email: string; name: string | null }) {
    try {
      const html = await renderTemplate("signup-pending", { name: user.name || "there" });
      await sendEmail({ to: user.email, subject: "Your ilovelawyer signup is pending approval", html });
    } catch (err) {
      logger.error("Failed to send signup-pending email", { err, userId: user.id });
    }
  }

  /** Flips a freshly verified PENDING account straight to ACTIVE when its Tenant has
   * auto-approve on (admin Settings page). Called at the moment the email becomes verified —
   * verifyOtp for password signups, account creation for Google ones — never at row creation
   * for password signups: AuthRepo.deleteUnverifiedPendingUser (cancelSignup) only matches
   * unverified PENDING rows, so an unverified ACTIVE row could never be cleaned up.
   * No session wipe or email, unlike AdminSvc.transition — the user is signing in right now
   * and the session about to be issued already sees ACTIVE. Also called by AdminSvc.verifyEmail,
   * where an admin marks the email verified in place of the OTP. Returns whether it approved. */
  static async autoApproveIfEnabled(user: { id: string; tenantId: string | null; approvalStatus: string }) {
    if (user.approvalStatus !== "PENDING") return false;
    if (!(await TenantSettingSvc.isAutoApproveOn(user.tenantId))) return false;
    await AuthRepo.setApprovalStatus(user.id, "ACTIVE", null);
    return true;
  }

  /** "Use a different email" on the sign-up OTP screen — lets an abandoned signup attempt be
   * cleaned up so the same email can be reused immediately, instead of permanently colliding
   * with (and, before this endpoint existed, occasionally 500ing) a later signup attempt. Same
   * anti-enumeration shape as sendOtp/forgotPassword below: always the same response regardless
   * of whether anything was actually deleted, so this can't be used to probe registered emails.
   * AuthRepo.deleteUnverifiedPendingUser is scoped so a verified or admin-approved/denied
   * account is never touched, no matter what email is passed in. */
  static async cancelSignup(email: string): Promise<{ message: string }> {
    const { count } = await AuthRepo.deleteUnverifiedPendingUser(email);
    if (count > 0) {
      await SecurityAuditSvc.record({
        action: "auth.signup_cancelled",
        actorId: null,
        organizationId: null,
        payload: { email: normalizeEmail(email) },
      });
    }
    return { message: "If a pending signup exists for this email, it has been cancelled" };
  }

  /** A user's account is exclusive to whichever Tenant their organization was created
   * under — signing in from the other Tenant's domain with the same account must be
   * rejected outright, not silently redirected post-login (see app/(protected)/layout.tsx on
   * the frontend for the older, looser redirect-based behavior this replaces at the trust
   * boundary). A user with no organization yet (verified but never finished onboarding) or an
   * unresolved request origin (non-subdomain host, e.g. local tooling) has nothing to conflict
   * with, so both are let through. 409, not 403 — unified-auth.tsx's sign-in handler already
   * treats a 403 from login() as "email not verified" and redirects to the OTP screen, which
   * would be wrong here (the email *is* verified) and would loop back into a verify-otp 400. */
  private static async assertTenantAccess(userId: string, requestTenantCode: TenantCode | null) {
    if (!requestTenantCode) return;
    const membership = await OrganizationMemberRepo.findAnyForUser(userId);
    if (!membership || membership.organization.tenant.code === requestTenantCode) return;
    throw new HttpError(
      `This account belongs to the ${membership.organization.tenant.code} tenant and cannot sign in from ${requestTenantCode}.`,
      409,
    );
  }

  /** Every path below that issues a session calls this once its checks have passed (refresh
   * never does): a completed sign-in during the deletion grace period restores the account —
   * see AccountDeletionSvc.restoreOnSignIn. Touches the DB only when the row the caller already
   * read shows a scheduled deletion. */
  private static async restoreIfScheduled(
    user: { id: string; email: string; name: string | null; deletionRequestedAt?: Date | null } | null,
  ): Promise<boolean> {
    if (!user?.deletionRequestedAt) return false;
    return AccountDeletionSvc.restoreOnSignIn(user);
  }

  /** Runs one sign-in path and writes its auth.login security audit row: SUCCESS naming the
   * signed-in user, or FAILURE with the refusal's reason and the email that was tried (so a firm
   * sees failed attempts against its members). `method` says which path it was. */
  private static async auditSignIn<T>(
    method: string,
    attemptedEmail: string | undefined,
    run: () => Promise<T>,
    signedInUserId: (result: T) => string | null | undefined,
  ): Promise<T> {
    let result: T;
    try {
      result = await run();
    } catch (err) {
      await SecurityAuditSvc.recordFailure({ action: "auth.login", actorId: null, attemptedEmail, payload: { method } }, err);
      throw err;
    }
    await SecurityAuditSvc.record({ action: "auth.login", actorId: signedInUserId(result) ?? null, payload: { method } });
    return result;
  }

  static async login(email: string, password: string, remember = false, requestTenantCode: TenantCode | null = null) {
    return AuthSvc.auditSignIn(
      "password",
      email,
      () => AuthSvc.passwordLogin(email, password, remember, requestTenantCode),
      (result) => result.user?.id,
    );
  }

  private static async passwordLogin(email: string, password: string, remember: boolean, requestTenantCode: TenantCode | null) {
    const user = await AuthRepo.findByEmail(email);
    // A Google SSO account gets the same generic 401 as a wrong password, so this endpoint
    // can't be used to learn which emails are Google accounts. forgotPassword emails the
    // owner a "use Continue with Google" note instead of a reset link.
    if (!user || !user.password || isGoogleSsoAccount(user)) {
      throw new HttpError("Invalid email or password", 401);
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      // Only for an account that exists; an unknown email has no actor to attribute it to, and
      // recording the typed address would store a stranger's personal data.
      await AuditSvc.record({ action: AuditAction.LoginFailed, actorId: user.id, payload: { reason: "wrong_password" } });
      throw new HttpError("Invalid email or password", 401);
    }

    if (!user.isEmailVerified) {
      throw new HttpError("Email not verified", 403);
    }

    // Legacy accounts created under the old, weaker password policy — one-time gate, cleared
    // by updateRequiredPassword below. 428 (Precondition Required), not 403, so it can't be
    // confused with the email-not-verified case above; unified-auth.tsx's sign-in handler
    // checks for this status specifically and routes to a "set a new password" step instead
    // of issuing a session. Never applied to ADMIN — those are bootstrap/seeded operator
    // accounts (see the migration's backfill), and ilovelawyer-admin has no self-service
    // recovery UI for this gate the way ilovelawyer-app does, so flagging one would lock
    // staff out with no way back in.
    if (user.mustChangePassword && user.role !== "ADMIN") {
      throw new HttpError("Password update required", 428);
    }

    await AuthSvc.assertTenantAccess(user.id, requestTenantCode);
    const deletionCancelled = await AuthSvc.restoreIfScheduled(user);

    const { accessToken, refreshToken } = loginToken(user.id, remember);

    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    await AuthRepo.createSession(user.id, refreshToken, expiresAt);
    await AuthRepo.updateLastLogin(user.id);
    await AuditSvc.record({ action: AuditAction.LoginSucceeded, actorId: user.id, payload: { method: "password" } });

    return {
      user: await AuthRepo.findById(user.id),
      accessToken,
      refreshToken,
      deletionCancelled,
    };
  }

  /** Completes the one-time forced password update for a legacy (mustChangePassword) account.
   * Re-verifies currentPassword itself rather than trusting a session, since login() above
   * blocks before a session is ever issued for this account — the same knowledge-of-current-
   * password check login() already did is what authorizes this call. On success, behaves like
   * a completed login: clears the gate, creates a session, and returns tokens the same shape
   * as login()'s, so the frontend can proceed exactly as it would after a normal sign-in. */
  static async updateRequiredPassword(
    email: string,
    currentPassword: string,
    newPassword: string,
    remember = false,
    requestTenantCode: TenantCode | null = null,
  ) {
    return AuthSvc.auditSignIn(
      "password_update",
      email,
      () => AuthSvc.applyRequiredPasswordUpdate(email, currentPassword, newPassword, remember, requestTenantCode),
      (result) => result.user?.id,
    );
  }

  private static async applyRequiredPasswordUpdate(
    email: string,
    currentPassword: string,
    newPassword: string,
    remember: boolean,
    requestTenantCode: TenantCode | null,
  ) {
    const user = await AuthRepo.findByEmail(email);
    if (!user || !user.password || isGoogleSsoAccount(user)) {
      throw new HttpError("Invalid email or password", 401);
    }

    const isValid = await bcrypt.compare(currentPassword, user.password);
    if (!isValid) {
      throw new HttpError("Invalid email or password", 401);
    }

    if (!user.mustChangePassword) {
      throw new HttpError("Password update was not required for this account", 409);
    }

    await AuthSvc.assertTenantAccess(user.id, requestTenantCode);

    const hashedPassword = await bcrypt.hash(newPassword, BCRYPT_SALT_ROUNDS);
    await AuthRepo.updatePasswordAndClearMustChange(user.id, hashedPassword);
    await SecurityAuditSvc.record({ action: "auth.password_changed", actorId: user.id, payload: { reason: "required_update" } });
    const deletionCancelled = await AuthSvc.restoreIfScheduled(user);

    const { accessToken, refreshToken } = loginToken(user.id, remember);

    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    await AuthRepo.createSession(user.id, refreshToken, expiresAt);
    await AuthRepo.updateLastLogin(user.id);
    await AuditSvc.record({ action: AuditAction.PasswordChanged, actorId: user.id, payload: { via: "required_update" } });
    await AuditSvc.record({ action: AuditAction.LoginSucceeded, actorId: user.id, payload: { method: "password_required_update" } });

    return {
      user: await AuthRepo.findById(user.id),
      accessToken,
      refreshToken,
      deletionCancelled,
    };
  }

  static async sendOtp(email: string) {
    // Mirrors forgotPassword()'s anti-enumeration pattern below: always the
    // same response, regardless of whether the account exists or is already
    // verified, so this endpoint can't be used to probe registered emails.
    const result = { message: "If the email exists and needs verification, a code will be sent" };

    const user = await AuthRepo.findByEmail(email);
    if (!user || user.isEmailVerified) {
      return result;
    }

    if (user.emailVerificationLastSentAt) {
      const elapsedMs = Date.now() - user.emailVerificationLastSentAt.getTime();
      if (elapsedMs < EMAIL_VERIFICATION_RESEND_COOLDOWN_MS) {
        return result;
      }
    }

    const code = generateOtpCode();
    const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_EXPIRY_MS);
    await AuthRepo.setEmailVerificationCode(user.id, code, expiresAt);

    const html = await renderTemplate("verify-email", {
      name: user.name || "there",
      code,
    });
    await sendEmail({ to: user.email, subject: "Verify your email", html });

    return result;
  }

  static async verifyOtp(email: string, code: string) {
    return AuthSvc.auditSignIn("email_verification", email, () => AuthSvc.verifyOtpAndSignIn(email, code), (result) => result.user?.id);
  }

  private static async verifyOtpAndSignIn(email: string, code: string) {
    const user = await AuthRepo.findByEmail(email);
    if (!user) {
      throw new HttpError("Invalid or expired code", 400);
    }

    if (user.isEmailVerified) {
      throw new HttpError("Email already verified", 400);
    }

    if (!user.emailVerificationCode || !user.emailVerificationExpiry || user.emailVerificationExpiry < new Date()) {
      throw new HttpError("Invalid or expired code", 400);
    }

    if (user.emailVerificationAttempts >= EMAIL_VERIFICATION_MAX_ATTEMPTS) {
      await AuthRepo.invalidateEmailVerificationCode(user.id);
      throw new HttpError("Too many incorrect attempts. Request a new code.", 400);
    }

    if (user.emailVerificationCode !== code) {
      await AuthRepo.incrementEmailVerificationAttempts(user.id);
      throw new HttpError("Invalid or expired code", 400);
    }

    await AuthRepo.markEmailVerified(user.id);
    await SecurityAuditSvc.record({ action: "auth.email_verified", actorId: user.id });
    await AuthSvc.autoApproveIfEnabled(user);
    await AuthRepo.updateLastLogin(user.id);

    // No "remember" preference exists at signup time — default true, matching
    // loginWithGoogle's default for the same reason (a fresh account, not a
    // returning-user login).
    const { accessToken, refreshToken } = loginToken(user.id, true);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    await AuthRepo.createSession(user.id, refreshToken, expiresAt);
    await AuditSvc.record({ action: AuditAction.LoginSucceeded, actorId: user.id, payload: { method: "email_otp" } });

    return {
      user: await AuthRepo.findById(user.id),
      accessToken,
      refreshToken,
    };
  }

  static async refresh(refreshToken: string, requestTenantCode: TenantCode | null = null) {
    let payload: { userId: string; remember?: boolean };
    try {
      payload = jwt.verify(refreshToken, REFRESH_TOKEN_SECRET) as { userId: string; remember?: boolean };
    } catch {
      throw new HttpError("Invalid or expired refresh token", 401);
    }

    const session = await AuthRepo.findByRefreshToken(refreshToken);
    if (!session) {
      throw new HttpError("Invalid or expired refresh token", 401);
    }

    // Without this, a refreshToken cookie left over on the "wrong" Tenant's subdomain
    // (e.g. from testing before this account's org existed, or before Tenants were
    // exclusive) would silently resume the session there — app/(auth)/layout.tsx's
    // redirect-if-authed check on /login redeems exactly this cookie, so a stale cross-
    // tenant session would auto-login and immediately bounce through the older
    // window.location redirect in app/(protected)/layout.tsx instead of ever showing the
    // sign-in form. Reusing the same 401/message as an actually-invalid token is deliberate:
    // every caller of refreshAccessToken() already treats any failure as "not logged in
    // here", so no frontend branching is needed — see assertTenantAccess above for why
    // login()/loginWithGoogle() use 409 instead. The token isn't deleted on this path (unlike
    // a normal rotation below) — it's still good for a refresh from its actual tenant.
    if (requestTenantCode) {
      const membership = await OrganizationMemberRepo.findAnyForUser(payload.userId);
      if (membership && membership.organization.tenant.code !== requestTenantCode) {
        throw new HttpError("Invalid or expired refresh token", 401);
      }
    }

    await AuthRepo.deleteByRefreshToken(refreshToken);

    const remember = !!payload.remember;
    const { accessToken, refreshToken: newRefreshToken } = loginToken(payload.userId, remember);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    await AuthRepo.createSession(payload.userId, newRefreshToken, expiresAt);

    return { accessToken, refreshToken: newRefreshToken, remember };
  }

  static async logout(refreshToken: string) {
    const session = await AuthRepo.findByRefreshToken(refreshToken);
    // The token is only decoded, not verified: an expired or forged one still ends the session
    // below, and the event just attributes it when the claim is present.
    const userId = (jwt.decode(refreshToken) as { userId?: string } | null)?.userId;
    await AuthRepo.deleteByRefreshToken(refreshToken);
    if (session) await SecurityAuditSvc.record({ action: "auth.logout", actorId: session.userId });
    if (userId) await AuditSvc.record({ action: AuditAction.LoggedOut, actorId: userId });
  }

  /** The 409 for a Google sign-in whose email already belongs to an account that isn't bound
   * to this Google identity. `code` tells the client what it can do next:
   * GOOGLE_LINK_REQUIRED → offer the password-confirmed link step (linkGoogle below);
   * GOOGLE_ACCOUNT_MISMATCH → the account is already bound to a *different* Google identity;
   * no code → nothing to offer here (the account lives on another Tenant's site, or is an
   * operator ADMIN account, which is never linked). */
  private static googleEmailConflict(
    existing: { email: string; role: string; googleId: string | null; tenant: { code: string; name: string } | null },
    requestTenantCode: TenantCode | null,
  ): HttpError {
    const message = duplicateEmailMessage(existing, "Email already registered with a different sign-in method", requestTenantCode);
    if (existing.googleId) {
      return new HttpError("This email is already connected to a different Google account", 409, "GOOGLE_ACCOUNT_MISMATCH");
    }
    if (existing.role === "ADMIN" || (existing.tenant && existing.tenant.code !== requestTenantCode)) {
      return new HttpError(message, 409);
    }
    // `email` lets the link step show which account it's about to connect to. Only ever sent
    // to a caller holding a valid Google token for this exact, Google-verified address, so it
    // reveals nothing they don't already know.
    return new HttpError(message, 409, "GOOGLE_LINK_REQUIRED", { email: existing.email });
  }

  /** `acceptedTerms` only matters when this call would create the account — a returning
   * Google user is never re-asked. Without it, nothing is created and the client gets 428
   * TERMS_ACCEPTANCE_REQUIRED so it can show the Terms and retry with the same token. */
  static async loginWithGoogle(
    idToken: string,
    remember = true,
    requestTenantCode: TenantCode | null = null,
    acceptedTerms = false,
  ) {
    return AuthSvc.auditSignIn(
      "google",
      undefined,
      () => AuthSvc.googleSignIn(idToken, remember, requestTenantCode, acceptedTerms),
      (result) => result.user?.id,
    );
  }

  private static async googleSignIn(idToken: string, remember: boolean, requestTenantCode: TenantCode | null, acceptedTerms: boolean) {
    const { googleId, email: googleEmail, name, picture, isEmailVerified } = await verifyGoogleToken(idToken);

    if (!googleId) {
      throw new HttpError("Invalid Google token", 401);
    }

    if (!isEmailVerified) {
      throw new HttpError("Google account email is not verified", 401);
    }

    const email = normalizeEmail(googleEmail);
    let user = await AuthRepo.findByGoogleId(googleId);
    let created = false;

    if (!user) {
      const existingByEmail = await AuthRepo.findByEmail(email);
      // A password signup that never verified its email (and was never admin-reviewed) is the
      // same limbo row cancelSignup already lets anyone clear — it never proved ownership of
      // this inbox, while Google just did. Replaced below rather than blocking the real owner
      // (and so a squatted, unverified signup can't be used to pre-hijack their account).
      const replacesAbandonedSignup =
        !!existingByEmail && !existingByEmail.isEmailVerified && existingByEmail.approvalStatus === "PENDING";
      if (existingByEmail && !replacesAbandonedSignup) {
        throw AuthSvc.googleEmailConflict(existingByEmail, requestTenantCode);
      }

      if (!acceptedTerms) {
        // 428 matches login()'s "one more step before a session" meaning, but clients must
        // branch on `code` — on /login, a bare 428 means the forced password update instead.
        throw new HttpError("Terms acceptance required", 428, "TERMS_ACCEPTANCE_REQUIRED");
      }

      if (replacesAbandonedSignup) {
        await AuthRepo.deleteUnverifiedPendingUser(email);
      }

      // Same lenient handling as password signup — see the comment there.
      const tenantId = requestTenantCode ? await TenantRepo.findIdByCode(requestTenantCode) : null;
      try {
        user = await AuthRepo.createGoogleUser({ email, googleId, name: name ?? undefined, tenantId, termsVersion: TERMS_VERSION });
        created = true;
      } catch (err) {
        // The findByGoogleId/findByEmail checks above aren't atomic with the insert — a
        // double click, two tabs or a retry can race another request for the same identity
        // past them. Resolve to whatever the winner created instead of a 500.
        user = await AuthSvc.resolveGoogleCreateRace(err, googleId, email, requestTenantCode);
      }
    }

    if (created) {
      await SecurityAuditSvc.record({ action: "auth.signup", actorId: user.id, payload: { method: "google" } });

      // Google has already verified the email, so this is the verification moment — the
      // counterpart of verifyOtp's call for password signups.
      const autoApproved = await AuthSvc.autoApproveIfEnabled(user);

      // Same as password signup — sent once, only by the request that actually created the
      // account. Returning users and the loser of a creation race never hit this (the winner
      // already auto-approved and emailed).
      if (!autoApproved) {
        await AuthSvc.sendSignupPendingEmail(user);
      }

      // The Google profile photo becomes the default avatar — copied once, here, and never on a
      // returning login or a link. Waited on briefly so the response (and the new user's first
      // screen) already carries it; a slow copy finishes in the background. Never fails sign-in.
      const photoImport = AvatarSvc.importGooglePhoto(user.id, picture);
      await Promise.race([photoImport, new Promise((resolve) => setTimeout(resolve, GOOGLE_PHOTO_SIGNUP_WAIT_MS).unref())]);
    } else {
      await AuthSvc.assertTenantAccess(user.id, requestTenantCode);
      await AuthRepo.updateLastLogin(user.id);
    }

    // A just-created account never has a deletion scheduled, so this only ever acts on a
    // returning user.
    const deletionCancelled = await AuthSvc.restoreIfScheduled(user);

    const { accessToken, refreshToken } = loginToken(user.id, remember);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    await AuthRepo.createSession(user.id, refreshToken, expiresAt);
    await AuditSvc.record({ action: AuditAction.LoginSucceeded, actorId: user.id, payload: { method: "google" } });

    return {
      user: await AuthRepo.findById(user.id),
      accessToken,
      refreshToken,
      deletionCancelled,
    };
  }

  /** Maps a failed createGoogleUser to the account a concurrent request created first. A
   * P2002 on `googleId` means this exact identity won the race — log into it. A P2002 on
   * `email` means some account took the address: the same identity (log in), or a different
   * one (the usual email conflict). Anything else is a real error and is rethrown. */
  private static async resolveGoogleCreateRace(
    err: unknown,
    googleId: string,
    email: string,
    requestTenantCode: TenantCode | null,
  ) {
    if (isUniqueViolation(err, "googleId")) {
      const winner = await AuthRepo.findByGoogleId(googleId);
      if (winner) return winner;
    }
    if (isUniqueViolation(err, "email")) {
      const winner = await AuthRepo.findByEmail(email);
      if (winner?.googleId === googleId) return winner;
      if (winner) throw AuthSvc.googleEmailConflict(winner, requestTenantCode);
    }
    throw err;
  }

  /** The GOOGLE_LINK_REQUIRED follow-up: attaches a verified Google identity to the existing
   * password account with the same email, but only once the caller proves they own that
   * account by its password. A verified email match alone isn't enough — a Google Workspace
   * domain can reassign an ex-employee's address to someone else, and linking must not skip
   * the gates login() enforces (verification, forced password update, Tenant). On success
   * behaves like a completed login(). */
  static async linkGoogle(idToken: string, password: string, remember = false, requestTenantCode: TenantCode | null = null) {
    return AuthSvc.auditSignIn(
      "google_link",
      undefined,
      () => AuthSvc.linkGoogleAndSignIn(idToken, password, remember, requestTenantCode),
      (result) => result.user?.id,
    );
  }

  private static async linkGoogleAndSignIn(idToken: string, password: string, remember: boolean, requestTenantCode: TenantCode | null) {
    const { googleId, email, isEmailVerified } = await verifyGoogleToken(idToken);

    if (!googleId) {
      throw new HttpError("Invalid Google token", 401);
    }

    if (!isEmailVerified) {
      throw new HttpError("Google account email is not verified", 401);
    }

    const user = await AuthRepo.findByEmail(email);
    if (!user || !user.password || isGoogleSsoAccount(user)) {
      throw new HttpError("Invalid email or password", 401);
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      throw new HttpError("Invalid email or password", 401);
    }

    if (user.role === "ADMIN") {
      throw new HttpError("Google sign-in can't be connected to this account", 409);
    }

    if (user.googleId && user.googleId !== googleId) {
      throw new HttpError("This email is already connected to a different Google account", 409, "GOOGLE_ACCOUNT_MISMATCH");
    }

    if (!user.isEmailVerified) {
      throw new HttpError("Email not verified", 403);
    }

    // Same gate and status as login() — the client routes to its "set a new password" step.
    if (user.mustChangePassword) {
      throw new HttpError("Password update required", 428);
    }

    await AuthSvc.assertTenantAccess(user.id, requestTenantCode);

    // Idempotent for a retry of a link that already went through.
    if (user.googleId !== googleId) {
      const linked = await AuthRepo.linkGoogleId(user.id, googleId);
      if (!linked) {
        throw new HttpError("This Google account could not be connected to this account", 409, "GOOGLE_ACCOUNT_MISMATCH");
      }
      await SecurityAuditSvc.record({ action: "auth.google_linked", actorId: user.id });

      try {
        const html = await renderTemplate("google-connected", { name: user.name || "there" });
        await sendEmail({ to: user.email, subject: "Google sign-in was connected to your ilovelawyer account", html });
      } catch (err) {
        logger.error("Failed to send google-connected email", { err, userId: user.id });
      }
    }

    const deletionCancelled = await AuthSvc.restoreIfScheduled(user);

    const { accessToken, refreshToken } = loginToken(user.id, remember);

    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    await AuthRepo.createSession(user.id, refreshToken, expiresAt);
    await AuthRepo.updateLastLogin(user.id);
    await AuditSvc.record({ action: AuditAction.LoginSucceeded, actorId: user.id, payload: { method: "google_link" } });

    return {
      user: await AuthRepo.findById(user.id),
      accessToken,
      refreshToken,
      deletionCancelled,
    };
  }

  /** Fresh Google Calendar access token for the signed-in user (see GoogleCalendarSvc). */
  static async refreshGoogleToken(userId: string) {
    return { access_token: await GoogleCalendarSvc.getAccessToken(userId) };
  }

  /** `requestOrigin`: the allow-listed frontend the request came from (requestFrontendOrigin), so
   * the emailed link opens on the same site the user is using. */
  static async forgotPassword(email: string, requestOrigin: string | null = null) {
    const user = await AuthRepo.findByEmail(email);
    const result = { message: "If the email exists, a reset link will be sent" };
    await SecurityAuditSvc.record({ action: "auth.password_reset_requested", actorId: null, attemptedEmail: email });

    // The site the user asked from, if it belongs to their Tenant; otherwise their Tenant's own
    // subdomain (uk./ph.), not the bare CLIENT_URL[0] — see emailLinkOrigin. user.tenant is
    // already on hand from findByEmail's include, so no extra lookup needed.
    const origin = emailLinkOrigin(user?.tenant?.code, requestOrigin);

    // Google SSO accounts never get a password (see isGoogleSsoAccount). Same response as
    // every other case, so it reveals nothing — only the inbox owner learns to use Google.
    if (user && isGoogleSsoAccount(user)) {
      const html = await renderTemplate("google-sign-in", { name: user.name || "there", loginLink: `${origin}/login` });
      await sendEmail({ to: user.email, subject: "Sign in to ilovelawyer with Google", html });
      return result;
    }

    if (user) {
      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + OTP_EXPIRY_MS);
      await AuthRepo.setResetToken(user.id, token, expiresAt);

      const resetLink = `${origin}/reset-password?token=${token}`;
      const html = await renderTemplate("reset-password", {
        name: user.name || "User",
        resetLink,
      });

      await sendEmail({
        to: user.email,
        subject: "Reset your password",
        html,
      });
    }

    return result;
  }

  static async validateResetToken(token: string): Promise<boolean> {
    return AuthRepo.isResetTokenValid(token);
  }

  static async resetPassword(token: string, password: string, remember = true) {
    return AuthSvc.auditSignIn(
      "password_reset",
      undefined,
      () => AuthSvc.resetPasswordAndSignIn(token, password, remember),
      (result) => result.userId,
    );
  }

  private static async resetPasswordAndSignIn(token: string, password: string, remember: boolean) {
    const hashedPassword = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
    const userId = await AuthRepo.consumeResetToken(token, hashedPassword);
    if (!userId) {
      throw new HttpError("Invalid or expired reset token", 400);
    }

    await AuthRepo.deleteSessionsByUserId(userId);
    await SecurityAuditSvc.record({ action: "auth.password_reset", actorId: userId });
    // Resetting the password signs the user in (below), so it restores a scheduled account too.
    const deletionCancelled = await AuthSvc.restoreIfScheduled(await AuthRepo.findById(userId));

    const { accessToken, refreshToken } = loginToken(userId, remember);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    await AuthRepo.createSession(userId, refreshToken, expiresAt);
    await AuditSvc.record({ action: AuditAction.PasswordChanged, actorId: userId, payload: { via: "reset_link" } });
    await AuditSvc.record({ action: AuditAction.LoginSucceeded, actorId: userId, payload: { method: "password_reset" } });

    return { accessToken, refreshToken, deletionCancelled, userId };
  }

  /** Consumes the one-time "Login" link sent in the approval email (AdminSvc.transition) and
   * mints a brand-new session — the counterpart to resetPassword above, which does the same
   * consume-token-then-login shape for the password-reset flow. */
  static async consumeLoginLink(token: string, remember = true) {
    return AuthSvc.auditSignIn(
      "login_link",
      undefined,
      () => AuthSvc.consumeLoginLinkAndSignIn(token, remember),
      (result) => result.user?.id,
    );
  }

  private static async consumeLoginLinkAndSignIn(token: string, remember: boolean) {
    const userId = await AuthRepo.consumeLoginLinkToken(token);
    if (!userId) {
      throw new HttpError("Invalid or expired login link", 400);
    }

    // Defense in depth: transition() already revoked sessions at approval time, but this
    // clears anything created since (e.g. a normal login the user did in the meantime).
    await AuthRepo.deleteSessionsByUserId(userId);
    const deletionCancelled = await AuthSvc.restoreIfScheduled(await AuthRepo.findById(userId));

    const { accessToken, refreshToken } = loginToken(userId, remember);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    await AuthRepo.createSession(userId, refreshToken, expiresAt);
    await AuthRepo.updateLastLogin(userId);
    await AuditSvc.record({ action: AuditAction.LoginSucceeded, actorId: userId, payload: { method: "login_link" } });

    return {
      user: await AuthRepo.findById(userId),
      accessToken,
      refreshToken,
      deletionCancelled,
    };
  }
}
