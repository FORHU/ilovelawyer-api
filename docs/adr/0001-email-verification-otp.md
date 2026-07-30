# 0001: Email Verification via OTP Blocks Login Until Confirmed

## Status

Accepted

## Context

Password-based Signup was designed — on the frontend, at least — around an assumption that a new account isn't usable until its email is verified: `useSignupMutation`'s `onSuccess` never calls `setAuth(...)`, only `useVerifyOtpMutation`'s does. But the backend never implemented that assumption:

- `POST /api/auth/send-otp` and `POST /api/auth/verify-otp` don't exist as routes at all — both calls 404 unconditionally.
- `AuthSvc.login()` never checks `isEmailVerified` — it only checks email/password.
- `User.isEmailVerified` defaults to `false` and is only ever set `true` for Google signups (Google has already verified the email). Nothing sets it `true` for password signups, because the route that would has never existed.

The practical result: a user can abandon the (permanently broken) OTP screen — e.g. via "Change Email," or by just navigating to `/login` directly — and sign in immediately with the credentials they just created. Email verification was fully bypassable, not because of a flaw in the gate, but because the gate was never built.

Separately, `User.otpCode`/`otpExpiry` already exist as columns, but are used exclusively by the password-reset flow (`AuthRepo.setResetToken` / `isResetTokenValid` / `consumeResetToken`). Reusing them for signup verification would let an unverified user's pending verification code and a password-reset token silently clobber each other (e.g. requesting a password reset before finishing signup verification overwrites the verification code, or vice versa on resend).

## Decision

1. **Login blocks on `isEmailVerified`.** Password-based `login()` refuses to authenticate an unverified user with a distinct, identifiable error (not the same generic "Invalid email or password" used for a wrong password). Google-signup users are unaffected — `isEmailVerified` is already `true` at creation for them.
2. **Dedicated columns.** Signup verification gets its own `emailVerificationCode` / `emailVerificationExpiry` columns on `User`, separate from the password-reset flow's `otpCode` / `otpExpiry`, so the two one-time-code flows can't collide.
3. **`verify-otp` logs the user in directly.** A correct code flips `isEmailVerified` to `true`, creates a Session (refresh-token cookie) exactly like `login()` does, and returns `{ accessToken, user }` — matching the response shape the frontend (`useVerifyOtpMutation`) already expects. There is no separate "verify, then log in again" step.
4. **Existing accounts are backfilled, not retroactively enforced.** Every existing `User` row gets `isEmailVerified = true` set as part of the migration that adds the new columns. The gate applies to signups from this point forward only — nobody who already has an account gets locked out, and no "verify an already-existing account" flow needs to be built.
5. **`send-otp` mirrors `forgotPassword()`'s anti-enumeration pattern.** It always returns the same generic success message; it only actually sends an email if a matching, still-unverified account exists. This keeps the endpoint consistent with the one other place in this codebase that already accepts an arbitrary, unauthenticated email address.
6. **`send-otp` enforces a server-side cooldown** (30s minimum between sends for the same email), independent of the frontend's `RESEND_COOLDOWN_SECONDS` button-disable, which by itself is trivially bypassed by calling the API directly.
7. **The verification code expires after 5 minutes** — deliberately shorter than the 1-hour `OTP_EXPIRY_MS` used for password-reset links, since it's meant to be entered immediately in the same browser session, not checked later via an emailed link. A shorter window also narrows the brute-force surface on a 6-digit code.
8. **`verify-otp` caps incorrect attempts at 5**, after which the current code is invalidated and a fresh `send-otp` is required. This closes the brute-force gap that expiry-time alone leaves open against a scripted attacker with no UI throttling.
9. **A failed login due to being unverified auto-triggers a fresh `send-otp`** as the frontend routes the user back to the OTP screen, rather than requiring an extra manual "Resend" click. Safe to do by construction: it's just another `send-otp` call, subject to the same anti-enumeration (5) and cooldown (6) protections as any other.

## Consequences

- Email verification becomes a real, enforced gate instead of a UI-only step that blocks nothing — closes the exact bypass reported ("skipping OTP still lets sign-in work").
- Two new endpoints (`send-otp`, `verify-otp`), a migration (two new `User` columns, a backfill `UPDATE`, likely an attempt-counter column or equivalent), and a new email template (alongside the existing password-reset one) are required.
- `login()`'s error handling grows a new branch (unverified vs. wrong-credentials), and the frontend needs to catch that specific error to route back into the OTP screen instead of showing a generic message.
- Accounts created before this ships are permanently exempt from ever verifying their email — accepted as the right tradeoff over locking out or retroactively chasing verification from everyone with an existing account.
