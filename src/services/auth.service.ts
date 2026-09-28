import bcrypt from "bcrypt";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { Prisma } from "@prisma/client";
import AuthRepo from "../repositories/auth.repository";
import OrganizationMemberRepo from "../repositories/organization-member.repository";
import TenantRepo from "../repositories/tenant.repository";
import loginToken from "../utils/loginToken";
import verifyGoogleToken from "../utils/googleToken";
import HttpError from "../utils/http-error";
import { sendEmail } from "../utils/mailer";
import { renderTemplate } from "../utils/template";
import type { TenantCode } from "../types/tenant-code";
import { REFRESH_TOKEN_SECRET, REFRESH_TOKEN_EXPIRY_DAYS, CLIENT_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } from "../config";
import {
  BCRYPT_SALT_ROUNDS,
  OTP_EXPIRY_MS,
  EMAIL_VERIFICATION_EXPIRY_MS,
  EMAIL_VERIFICATION_RESEND_COOLDOWN_MS,
  EMAIL_VERIFICATION_MAX_ATTEMPTS,
  HANDOFF_TTL_SECONDS,
} from "../constants";
import { generateOtpCode, duplicateEmailMessage } from "../utils/auth.utils";
import { newHandoffCode, handoffKey } from "../utils/handoff";
import { redis } from "../lib/redis";

export default class AuthSvc {
  static async signup(username: string, email: string, password: string, name: string, requestTenantCode: TenantCode | null = null) {
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
      user = await AuthRepo.createUser({ username, email, password: hashedPassword, name, tenantId });
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
    const html = await renderTemplate("signup-pending", { name: user.name || "there" });
    await sendEmail({ to: user.email, subject: "Your ilovelawyer signup is pending approval", html });

    return user;
  }

  /** "Use a different email" on the sign-up OTP screen — lets an abandoned signup attempt be
   * cleaned up so the same email can be reused immediately, instead of permanently colliding
   * with (and, before this endpoint existed, occasionally 500ing) a later signup attempt. Same
   * anti-enumeration shape as sendOtp/forgotPassword below: always the same response regardless
   * of whether anything was actually deleted, so this can't be used to probe registered emails.
   * AuthRepo.deleteUnverifiedPendingUser is scoped so a verified or admin-approved/denied
   * account is never touched, no matter what email is passed in. */
  static async cancelSignup(email: string): Promise<{ message: string }> {
    await AuthRepo.deleteUnverifiedPendingUser(email);
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

  static async login(email: string, password: string, remember = false, requestTenantCode: TenantCode | null = null) {
    const user = await AuthRepo.findByEmail(email);
    if (!user || !user.password) {
      throw new HttpError("Invalid email or password", 401);
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
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

    const { accessToken, refreshToken } = loginToken(user.id, remember);

    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    await AuthRepo.createSession(user.id, refreshToken, expiresAt);
    await AuthRepo.updateLastLogin(user.id);

    return {
      user: await AuthRepo.findById(user.id),
      accessToken,
      refreshToken,
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
    const user = await AuthRepo.findByEmail(email);
    if (!user || !user.password) {
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

    const { accessToken, refreshToken } = loginToken(user.id, remember);

    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    await AuthRepo.createSession(user.id, refreshToken, expiresAt);
    await AuthRepo.updateLastLogin(user.id);

    return {
      user: await AuthRepo.findById(user.id),
      accessToken,
      refreshToken,
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
    await AuthRepo.updateLastLogin(user.id);

    // No "remember" preference exists at signup time — default true, matching
    // loginWithGoogle's default for the same reason (a fresh account, not a
    // returning-user login).
    const { accessToken, refreshToken } = loginToken(user.id, true);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    await AuthRepo.createSession(user.id, refreshToken, expiresAt);

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
    await AuthRepo.deleteByRefreshToken(refreshToken);
  }

  static async loginWithGoogle(idToken: string, remember = true, requestTenantCode: TenantCode | null = null) {
    const { googleId, email, name, isEmailVerified } = await verifyGoogleToken(idToken);

    if (!googleId) {
      throw new HttpError("Invalid Google token", 401);
    }

    if (!isEmailVerified) {
      throw new HttpError("Google account email is not verified", 401);
    }

    let user = await AuthRepo.findByGoogleId(googleId);

    if (!user) {
      const existingByEmail = await AuthRepo.findByEmail(email);
      if (existingByEmail) {
        throw new HttpError(duplicateEmailMessage(existingByEmail, "Email already registered with a different sign-in method", requestTenantCode), 409);
      }

      // Same lenient handling as password signup — see the comment there.
      const tenantId = requestTenantCode ? await TenantRepo.findIdByCode(requestTenantCode) : null;
      user = await AuthRepo.createGoogleUser(email, googleId, name ?? undefined, tenantId);

      // Same as password signup — sent once, right at account creation. Returning
      // Google users (the `else` branch) never hit this again.
      const html = await renderTemplate("signup-pending", { name: user.name || "there" });
      await sendEmail({ to: user.email, subject: "Your ilovelawyer signup is pending approval", html });
    } else {
      await AuthSvc.assertTenantAccess(user.id, requestTenantCode);
      await AuthRepo.updateLastLogin(user.id);
    }

    const { accessToken, refreshToken } = loginToken(user.id, remember);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    await AuthRepo.createSession(user.id, refreshToken, expiresAt);

    return {
      user: await AuthRepo.findById(user.id),
      accessToken,
      refreshToken,
    };
  }

  static async refreshGoogleToken(userId: string) {
    const googleRefreshToken = await AuthRepo.findGoogleRefreshToken(userId);
    if (!googleRefreshToken) {
      throw new HttpError("No refresh token — user must reconnect Google", 400);
    }

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: googleRefreshToken,
        grant_type: "refresh_token",
      }),
    });

    const data = await tokenRes.json();
    if (!tokenRes.ok || !data.access_token) {
      throw new HttpError(data.error ?? "Refresh failed", 400);
    }

    await AuthRepo.updateGoogleAccessToken(userId, data.access_token);

    return { access_token: data.access_token };
  }

  static async forgotPassword(email: string) {
    const user = await AuthRepo.findByEmail(email);
    const result = { message: "If the email exists, a reset link will be sent" };

    if (user) {
      const token = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + OTP_EXPIRY_MS);
      await AuthRepo.setResetToken(user.id, token, expiresAt);

      const resetLink = `${CLIENT_URL[0]}/reset-password?token=${token}`;
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
    const hashedPassword = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
    const userId = await AuthRepo.consumeResetToken(token, hashedPassword);
    if (!userId) {
      throw new HttpError("Invalid or expired reset token", 400);
    }

    await AuthRepo.deleteSessionsByUserId(userId);

    const { accessToken, refreshToken } = loginToken(userId, remember);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    await AuthRepo.createSession(userId, refreshToken, expiresAt);

    return { accessToken, refreshToken };
  }

  /** Consumes the one-time "Login" link sent in the approval email (AdminSvc.transition) and
   * mints a brand-new session — the counterpart to resetPassword above, which does the same
   * consume-token-then-login shape for the password-reset flow. */
  static async consumeLoginLink(token: string, remember = true) {
    const userId = await AuthRepo.consumeLoginLinkToken(token);
    if (!userId) {
      throw new HttpError("Invalid or expired login link", 400);
    }

    // Defense in depth: transition() already revoked sessions at approval time, but this
    // clears anything created since (e.g. a normal login the user did in the meantime).
    await AuthRepo.deleteSessionsByUserId(userId);

    const { accessToken, refreshToken } = loginToken(userId, remember);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    await AuthRepo.createSession(userId, refreshToken, expiresAt);
    await AuthRepo.updateLastLogin(userId);

    return {
      user: await AuthRepo.findById(userId),
      accessToken,
      refreshToken,
    };
  }

  /** Step 1 of a desktop ↔ browser login handoff (see utils/handoff.ts): a one-time code the
   * logged-in caller passes to its other client. 503 if it can't be stored — better a clear
   * failure now than a code that silently doesn't work on the other side. */
  static async issueHandoff(userId: string) {
    const code = newHandoffCode();
    const stored = await redis.setOrFail(handoffKey(code), userId, HANDOFF_TTL_SECONDS);
    if (!stored) {
      throw new HttpError("Could not start the handoff — try again in a moment", 503);
    }
    return { code, expiresInSeconds: HANDOFF_TTL_SECONDS };
  }

  /** Step 1½: who a handoff code would sign the caller in as — WITHOUT using it up. The receiving
   * side shows "Sign in as …?" before consuming, so a crafted link carrying someone else's code
   * can't silently switch the user's app or browser to that account. Only name/email, and only
   * to whoever holds the code (which the issuer handed over deliberately). */
  static async previewHandoff(code: string) {
    const userId = await redis.get<string>(handoffKey(code));
    const user = userId ? await AuthRepo.findById(userId) : null;
    if (!user) {
      throw new HttpError("This sign-in link has expired or was already used", 400);
    }
    return { id: user.id, email: user.email, name: user.name, username: user.username };
  }

  /** Step 2: trades a handoff code for a login of the caller's own. Same outcome as a password
   * login — new session, same UK/PH site check — except no password: the code is the proof, and
   * it's single-use (atomic take). Other sessions are left alone, so handing off to the browser
   * never logs the desktop app out, and vice versa. */
  static async consumeHandoff(code: string, requestTenantCode: TenantCode | null = null) {
    const userId = await redis.take<string>(handoffKey(code));
    if (!userId) {
      throw new HttpError("This sign-in link has expired or was already used", 400);
    }
    const user = await AuthRepo.findById(userId);
    if (!user) {
      throw new HttpError("This sign-in link has expired or was already used", 400);
    }

    await AuthSvc.assertTenantAccess(userId, requestTenantCode);

    // `remember`: yes — both clients are on the user's own PC, and the one handing off is
    // already signed in there.
    const { accessToken, refreshToken } = loginToken(userId, true);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    await AuthRepo.createSession(userId, refreshToken, expiresAt);
    await AuthRepo.updateLastLogin(userId);

    return { user, accessToken, refreshToken };
  }
}
