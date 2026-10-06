import prisma from "../lib/prisma";
import { ApprovalStatus, Prisma } from "@prisma/client";
import { redis } from "../lib/redis";
import { GOOGLE_USERNAME_MAX_ATTEMPTS, USERS_LIST_VERSION_KEY } from "../constants";
import { isGoogleSsoAccount, isUniqueViolation, normalizeEmail } from "../utils/auth.utils";
import { getStableProxyFileUrl } from "../utils/s3";

// Shared by findById/updateProfile/setDeletionRequested below — the frontend replaces its
// entire cached /me response with whatever any of these return, so all three must expose the
// same shape (see setDeletionRequested's note). `password`, `avatar` and `googleRefreshToken` are
// selected only to derive `hasPassword`, `avatarUrl` and `googleCalendarConnected` in
// toPublicUser and are never included in what's returned.
const PUBLIC_USER_SELECT = {
  id: true,
  username: true,
  email: true,
  name: true,
  role: true,
  isEmailVerified: true,
  approvalStatus: true,
  denialReason: true,
  onboardingCompleted: true,
  provider: true,
  avatarId: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
  deletionRequestedAt: true,
  password: true,
  avatar: { select: { s3Key: true } },
  googleRefreshToken: true,
} as const;

/** `hasPassword` means "can sign in with a password" — always false for a Google SSO account,
 * even one holding a password an older build let it set through the reset flow. */
/** `avatarUrl` is a same-origin /files/<token> URL (stable for an hour — see
 * getStableProxyFileUrl), or null when there's no avatar and the app shows initials.
 * `googleCalendarConnected` only reports that a refresh token is stored; the token never leaves. */
function toPublicUser<
  T extends {
    password: string | null;
    provider: string | null;
    avatar?: { s3Key: string | null } | null;
    googleRefreshToken?: string | null;
  },
>(user: T): Omit<T, "password" | "avatar" | "googleRefreshToken"> & {
  hasPassword: boolean;
  avatarUrl: string | null;
  googleCalendarConnected: boolean;
} {
  const { password, avatar, googleRefreshToken, ...rest } = user;
  return {
    ...rest,
    hasPassword: password !== null && !isGoogleSsoAccount(user),
    avatarUrl: avatar?.s3Key ? getStableProxyFileUrl(avatar.s3Key) : null,
    googleCalendarConnected: !!googleRefreshToken,
  };
}

/** Reset tokens only ever apply to accounts that sign in with a password — a token emailed to a
 * Google SSO account before forgotPassword stopped issuing them must not set a password now.
 * Spelled as an OR: `provider: { not: "google" }` alone compiles to `provider <> 'google'`,
 * which is NULL (so no match) for password signups, whose provider is null. */
const PASSWORD_ACCOUNT_WHERE: Prisma.UserWhereInput = {
  OR: [{ provider: null }, { provider: { not: "google" } }],
};

/** AdminSvc.listUsers caches each page under the current USERS_LIST_VERSION_KEY; bumping it
 * orphans every cached page at once. Every write below that adds/removes a user row, or changes
 * a column listUsers selects, passes its result through here, so the admin list reflects a
 * signup, login, verification or approval immediately rather than after USERS_LIST_CACHE_TTL_S.
 * Writes to columns the list doesn't show (tokens, OTP codes, sessions) deliberately skip it.
 * Best-effort: redis.incr never throws, so Redis being down can't fail the write itself. */
async function bustUsersList<T>(result: T): Promise<T> {
  await redis.incr(USERS_LIST_VERSION_KEY);
  return result;
}

export default class AuthRepo {
  /** `termsVersion` is set only when the caller actually received a Terms acceptance with the
   * request — it's stamped together with `termsAcceptedAt`, never one without the other. */
  static async createUser(data: {
    username: string;
    email: string;
    password: string;
    name: string;
    tenantId?: string | null;
    termsVersion?: string | null;
  }) {
    return bustUsersList(
      await prisma.user.create({
        data: {
          username: data.username,
          email: normalizeEmail(data.email),
          password: data.password,
          name: data.name,
          tenantId: data.tenantId,
          ...(data.termsVersion ? { termsAcceptedAt: new Date(), termsVersion: data.termsVersion } : {}),
        },
      })
    );
  }

  /** Includes the user's Tenant code/name — used to tell a duplicate-signup attempt whether
   * (and where) the existing account actually belongs (see AuthSvc.signup / loginWithGoogle).
   * Harmless extra field for every other caller (login, forgotPassword). Normalizes `email`
   * itself as well as every service doing so, so no future caller can reintroduce a
   * case-sensitive lookup by forgetting to. */
  static async findByEmail(email: string) {
    return prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
      include: { tenant: { select: { code: true, name: true } } },
    });
  }

  /** The locale this user asked to be addressed in (User.preferredLanguage). Read per chat turn
   * by ChatSvc when Jev's language read is too uncertain to act on — see resolveReplyLanguage,
   * which defers to the person's own stated language rather than to a house default. */
  static async findPreferredLanguage(id: string): Promise<string | null> {
    const user = await prisma.user.findUnique({ where: { id }, select: { preferredLanguage: true } });
    return user?.preferredLanguage ?? null;
  }

  static async findById(id: string) {
    const user = await prisma.user.findUnique({ where: { id }, select: PUBLIC_USER_SELECT });
    return user ? toPublicUser(user) : null;
  }

  /** Unlike findById, includes the actual password hash — used only for verifying the current
   * password in UsersSvc.changePassword. Never expose this result directly to a client. */
  static async findByIdWithPasswordHash(id: string) {
    return prisma.user.findUnique({ where: { id }, select: { id: true, password: true, provider: true } });
  }

  /** Clears mustChangePassword in the same write — every password update goes through
   * strongPassword validation now, so every caller of this satisfies the forced-update
   * gate as a side effect, whether or not that's what motivated the call. */
  static async updatePasswordAndClearMustChange(userId: string, hashedPassword: string) {
    return bustUsersList(
      await prisma.user.update({ where: { id: userId }, data: { password: hashedPassword, mustChangePassword: false } })
    );
  }

  static async updateLastLogin(userId: string) {
    return bustUsersList(await prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } }));
  }

  /** No bustUsersList: onboardingCompleted isn't a column AdminSvc.listUsers shows. */
  static async setOnboardingCompleted(userId: string) {
    return prisma.user.update({ where: { id: userId }, data: { onboardingCompleted: true } });
  }

  static async findByUsername(username: string) {
    return prisma.user.findUnique({ where: { username } });
  }

  static async updateProfile(userId: string, data: { name?: string; username?: string }) {
    const user = await prisma.user.update({ where: { id: userId }, data, select: PUBLIC_USER_SELECT });
    return bustUsersList(toPublicUser(user));
  }

  static async deleteUser(userId: string) {
    return bustUsersList(await prisma.user.delete({ where: { id: userId } }));
  }

  /** Marks (or, given `null`, unmarks) a user for self-service deletion — see
   * ACCOUNT_DELETION_GRACE_PERIOD_DAYS and AccountDeletionQueue. Selects the same full shape as
   * findById/updateProfile (not just the touched field) since the frontend replaces its cached
   * /me response with whatever this returns — a partial object here would blank out fields like
   * approvalStatus and incorrectly bounce an ACTIVE user to the pending-approval screen. */
  static async setDeletionRequested(userId: string, requestedAt: Date | null) {
    const user = await prisma.user.update({
      where: { id: userId },
      data: { deletionRequestedAt: requestedAt },
      select: PUBLIC_USER_SELECT,
    });
    return toPublicUser(user);
  }

  /** Signing in cancels a scheduled deletion (AccountDeletionSvc.restoreOnSignIn). Conditional,
   * so of two simultaneous sign-ins only one sees `true` and sends the "restored" email. */
  static async clearDeletionRequestIfSet(userId: string): Promise<boolean> {
    const { count } = await prisma.user.updateMany({
      where: { id: userId, deletionRequestedAt: { not: null } },
      data: { deletionRequestedAt: null },
    });
    return count === 1;
  }

  /** Users whose grace period has fully elapsed as of `cutoff` (i.e. `now - gracePeriod`) —
   * candidates for AccountDeletionQueue to hard-delete. Paged by id like
   * ChatRepo.findConsultationsDueForDeletion. */
  static async findDueForHardDeletion(cutoff: Date, opts: { afterId?: string; take?: number } = {}) {
    return prisma.user.findMany({
      where: { deletionRequestedAt: { lte: cutoff }, ...(opts.afterId && { id: { gt: opts.afterId } }) },
      select: { id: true, email: true, name: true },
      orderBy: { id: "asc" },
      ...(opts.take && { take: opts.take }),
    });
  }

  static async findDeletionRequestedAt(userId: string): Promise<Date | null> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { deletionRequestedAt: true } });
    return user?.deletionRequestedAt ?? null;
  }

  /** AccountDeletionQueue's final delete — only while the request is still due, so a user who
   * signed in a moment ago (clearing deletionRequestedAt) is never removed. */
  static async deleteUserIfDeletionDue(userId: string, cutoff: Date): Promise<boolean> {
    const { count } = await prisma.user.deleteMany({ where: { id: userId, deletionRequestedAt: { lte: cutoff } } });
    if (count > 0) await bustUsersList(null);
    return count > 0;
  }

  /** Self-service "use a different email" cleanup (AuthSvc.cancelSignup) — scoped narrowly so
   * it can only ever remove a signup that's still genuinely in limbo, never a real account: an
   * email that's been verified, or a row an admin has since approved/denied, doesn't match and
   * is left untouched. `deleteMany` (not `delete`) so a no-match is a silent no-op rather than
   * a thrown "record not found". */
  static async deleteUnverifiedPendingUser(email: string) {
    const result = await prisma.user.deleteMany({
      where: { email: normalizeEmail(email), isEmailVerified: false, approvalStatus: "PENDING" },
    });
    return result.count > 0 ? bustUsersList(result) : result;
  }

  static async findByRefreshToken(refreshToken: string) {
    return prisma.session.findUnique({ where: { refreshToken } });
  }

  static async createSession(userId: string, refreshToken: string, expiresAt: Date) {
    return prisma.session.create({ data: { userId, refreshToken, expiresAt } });
  }

  static async deleteByRefreshToken(refreshToken: string) {
    return prisma.session.deleteMany({ where: { refreshToken } });
  }

  static async deleteSessionsByUserId(userId: string) {
    return prisma.session.deleteMany({ where: { userId } });
  }

  static async findByGoogleId(googleId: string) {
    return prisma.user.findUnique({ where: { googleId } });
  }

  /** Creates a first-time Google user. The username is claimed by trying the insert and
   * retrying on a `username` collision (P2002) with a fresh numeric suffix — a findUnique
   * pre-check isn't atomic with the insert, so two concurrent signups deriving the same base
   * (john@a.com / john@b.com) could both pass it. Any other P2002 (`googleId`, `email`) is a
   * race on the identity itself and is rethrown for AuthSvc.loginWithGoogle to resolve. */
  static async createGoogleUser(data: {
    email: string;
    googleId: string;
    name?: string;
    tenantId?: string | null;
    termsVersion: string;
  }) {
    const email = normalizeEmail(data.email);
    const base = email.split("@")[0].replace(/[^a-zA-Z0-9_]/g, "").slice(0, 20) || "user";

    for (let attempt = 0; ; attempt++) {
      const username = attempt === 0 ? base : `${base}${Math.floor(Math.random() * 9000) + 1000}`;
      try {
        return bustUsersList(
          await prisma.user.create({
            data: {
              username,
              email,
              googleId: data.googleId,
              name: data.name,
              provider: "google",
              isEmailVerified: true,
              lastLoginAt: new Date(),
              tenantId: data.tenantId,
              termsAcceptedAt: new Date(),
              termsVersion: data.termsVersion,
            },
          })
        );
      } catch (err) {
        if (isUniqueViolation(err, "username") && attempt + 1 < GOOGLE_USERNAME_MAX_ATTEMPTS) continue;
        throw err;
      }
    }
  }

  /** Attaches a Google identity to an existing account (AuthSvc.linkGoogle). Conditional on
   * `googleId` still being null, re-evaluated atomically by Postgres at update time — so a
   * concurrent link can't overwrite one that just landed. Returns false when nothing was
   * linked: the row already has a Google identity, or this `googleId` belongs to another
   * account (P2002). No bustUsersList: googleId isn't a column AdminSvc.listUsers shows. */
  static async linkGoogleId(userId: string, googleId: string): Promise<boolean> {
    try {
      const result = await prisma.user.updateMany({ where: { id: userId, googleId: null }, data: { googleId } });
      return result.count > 0;
    } catch (err) {
      if (isUniqueViolation(err, "googleId")) return false;
      throw err;
    }
  }

  /** The stored (encrypted) Google Calendar refresh token and last access token — see
   * GoogleCalendarSvc, the only caller that decrypts them. */
  static async findGoogleCalendarTokens(userId: string) {
    return prisma.user.findUnique({
      where: { id: userId },
      select: { googleAccessToken: true, googleRefreshToken: true, googleCalendarSyncToken: true },
    });
  }

  /** Everyone with Google Calendar connected — GoogleCalendarSyncQueue polls each of them. */
  static async findGoogleCalendarUserIds(): Promise<string[]> {
    const rows = await prisma.user.findMany({ where: { googleRefreshToken: { not: null } }, select: { id: true } });
    return rows.map((r) => r.id);
  }

  /** Where the two-way sync left off; null makes the next poll take a fresh baseline. */
  static async setGoogleCalendarSyncToken(userId: string, syncToken: string | null) {
    return prisma.user.update({ where: { id: userId }, data: { googleCalendarSyncToken: syncToken } });
  }

  /** `encryptedRefreshToken` is omitted when Google didn't return a new one (a reconnect without
   * fresh consent) — the stored one is kept rather than overwritten with null. */
  static async setGoogleCalendarTokens(userId: string, data: { accessToken: string; encryptedRefreshToken?: string }) {
    return prisma.user.update({
      where: { id: userId },
      data: {
        googleAccessToken: data.accessToken,
        ...(data.encryptedRefreshToken ? { googleRefreshToken: data.encryptedRefreshToken } : {}),
        // Possibly a different Google account than before — start the pull from a fresh baseline.
        googleCalendarSyncToken: null,
      },
    });
  }

  static async updateGoogleAccessToken(userId: string, accessToken: string) {
    return prisma.user.update({ where: { id: userId }, data: { googleAccessToken: accessToken } });
  }

  static async clearGoogleCalendarTokens(userId: string) {
    return prisma.user.update({
      where: { id: userId },
      data: { googleAccessToken: null, googleRefreshToken: null, googleCalendarSyncToken: null },
    });
  }

  static async findAvatarFile(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { avatar: { select: { id: true, s3Key: true } } },
    });
    return user?.avatar ?? null;
  }

  /** Sets the avatar only while none is set — re-evaluated atomically by Postgres, so the
   * background Google-photo import can never overwrite a photo the user uploaded meanwhile.
   * No bustUsersList: the admin list doesn't show avatars. */
  static async setAvatarIfEmpty(userId: string, fileId: string): Promise<boolean> {
    const result = await prisma.user.updateMany({ where: { id: userId, avatarId: null }, data: { avatarId: fileId } });
    return result.count > 0;
  }

  /** Points the user at `fileId` (or null for initials) and returns the public user shape. */
  static async setAvatar(userId: string, fileId: string | null) {
    const user = await prisma.user.update({ where: { id: userId }, data: { avatarId: fileId }, select: PUBLIC_USER_SELECT });
    return toPublicUser(user);
  }

  static async setResetToken(userId: string, token: string, expiresAt: Date) {
    return prisma.user.update({ where: { id: userId }, data: { otpCode: token, otpExpiry: expiresAt } });
  }

  static async setEmailVerificationOtp(userId: string, code: string, expiresAt: Date) {
    return prisma.user.update({
      where: { id: userId },
      data: { emailVerificationOtp: code, emailVerificationOtpExpiry: expiresAt },
    });
  }

  static async consumeEmailVerificationOtp(email: string, code: string) {
    const user = await prisma.user.findFirst({
      where: { email: normalizeEmail(email), emailVerificationOtp: code, emailVerificationOtpExpiry: { gt: new Date() } },
    });
    if (!user) return null;

    // Re-evaluated atomically by Postgres at update time, same race-safety as consumeResetToken.
    const result = await prisma.user.updateMany({
      where: { id: user.id, emailVerificationOtp: code, emailVerificationOtpExpiry: { gt: new Date() } },
      data: { isEmailVerified: true, emailVerificationOtp: null, emailVerificationOtpExpiry: null },
    });

    return result.count > 0 ? bustUsersList(user) : null;
  }

  static async isResetTokenValid(token: string): Promise<boolean> {
    const user = await prisma.user.findFirst({
      where: { otpCode: token, otpExpiry: { gt: new Date() }, ...PASSWORD_ACCOUNT_WHERE },
      select: { id: true },
    });
    return !!user;
  }

  static async consumeResetToken(token: string, hashedPassword: string): Promise<string | null> {
    const user = await prisma.user.findFirst({
      where: { otpCode: token, otpExpiry: { gt: new Date() }, ...PASSWORD_ACCOUNT_WHERE },
      select: { id: true },
    });
    if (!user) return null;

    // The WHERE clause here is re-evaluated atomically by Postgres at update time,
    // not at the time of the findFirst above — so concurrent requests racing on the
    // same token still only let one of them actually match and consume it.
    const result = await prisma.user.updateMany({
      where: { id: user.id, otpCode: token, otpExpiry: { gt: new Date() }, ...PASSWORD_ACCOUNT_WHERE },
      // Completing a reset via the emailed link is proof of ownership of that inbox,
      // so it also satisfies email verification — otherwise an unverified account that
      // resets its password would still be locked out of login by the isEmailVerified
      // check right after successfully resetting. resetPasswordSchema already enforces
      // the current strong-password policy, so this also satisfies mustChangePassword —
      // without clearing it here, a legacy user who resets via email would still hit the
      // forced-update wall on their next login despite already having a compliant password.
      data: { password: hashedPassword, otpCode: null, otpExpiry: null, isEmailVerified: true, mustChangePassword: false },
    });

    return result.count > 0 ? bustUsersList(user.id) : null;
  }

  static async setLoginLinkToken(userId: string, token: string, expiresAt: Date) {
    return prisma.user.update({ where: { id: userId }, data: { loginLinkToken: token, loginLinkTokenExpiry: expiresAt } });
  }

  /** Race-safe single-use consumption, same pattern as consumeResetToken: the WHERE clause on
   * the updateMany is re-evaluated atomically by Postgres at update time, so two concurrent
   * requests racing the same link only ever let one through. Also requires approvalStatus
   * still ACTIVE — a link emailed at approval time must not still work if the account was
   * blocked/denied again before it was clicked. */
  static async consumeLoginLinkToken(token: string): Promise<string | null> {
    const user = await prisma.user.findFirst({
      where: { loginLinkToken: token, loginLinkTokenExpiry: { gt: new Date() }, approvalStatus: "ACTIVE" },
      select: { id: true },
    });
    if (!user) return null;

    const result = await prisma.user.updateMany({
      where: { id: user.id, loginLinkToken: token, loginLinkTokenExpiry: { gt: new Date() }, approvalStatus: "ACTIVE" },
      data: { loginLinkToken: null, loginLinkTokenExpiry: null },
    });

    return result.count > 0 ? user.id : null;
  }

  static async setEmailVerificationCode(userId: string, code: string, expiresAt: Date) {
    return prisma.user.update({
      where: { id: userId },
      data: {
        emailVerificationCode: code,
        emailVerificationExpiry: expiresAt,
        emailVerificationAttempts: 0,
        emailVerificationLastSentAt: new Date(),
      },
    });
  }

  static async incrementEmailVerificationAttempts(userId: string): Promise<number> {
    const user = await prisma.user.update({
      where: { id: userId },
      data: { emailVerificationAttempts: { increment: 1 } },
      select: { emailVerificationAttempts: true },
    });
    return user.emailVerificationAttempts;
  }

  static async invalidateEmailVerificationCode(userId: string) {
    return prisma.user.update({
      where: { id: userId },
      data: { emailVerificationCode: null, emailVerificationExpiry: null },
    });
  }

  static async markEmailVerified(userId: string) {
    return bustUsersList(
      await prisma.user.update({
        where: { id: userId },
        data: {
          isEmailVerified: true,
          emailVerificationCode: null,
          emailVerificationExpiry: null,
          emailVerificationAttempts: 0,
        },
      })
    );
  }

  static async listUsers(params: {
    page: number;
    limit: number;
    sortBy: "name" | "email" | "createdAt" | "lastLoginAt";
    sortDir: "asc" | "desc";
    q?: string;
  }) {
    const { page, limit, sortBy, sortDir, q } = params;

    // Admins manage regular signups here, not other admin accounts.
    const where: Prisma.UserWhereInput = {
      role: "USER",
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { username: { contains: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const select = {
      id: true,
      name: true,
      username: true,
      email: true,
      role: true,
      tenant: { select: { name: true } },
      provider: true,
      isEmailVerified: true,
      approvalStatus: true,
      mustChangePassword: true,
      createdAt: true,
      lastLoginAt: true,
    } as const;

    const [data, total] = await prisma.$transaction([
      prisma.user.findMany({
        where,
        select,
        orderBy: { [sortBy]: sortDir },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.user.count({ where }),
    ]);

    return { data, total };
  }

  /** Accounts "Approve all pending" would take for a Tenant: regular users still PENDING whose
   * email is verified. Unverified ones are deliberately left alone so cancelSignup's
   * deleteUnverifiedPendingUser can still clean them up — they're auto-approved at verifyOtp
   * instead if the Tenant's switch is on. */
  private static approvablePendingWhere(tenantId: string): Prisma.UserWhereInput {
    return { tenantId, role: "USER", approvalStatus: "PENDING", isEmailVerified: true };
  }

  static async countApprovablePending(tenantId: string) {
    return prisma.user.count({ where: AuthRepo.approvablePendingWhere(tenantId) });
  }

  static async findApprovablePendingIds(tenantId: string) {
    const rows = await prisma.user.findMany({
      where: AuthRepo.approvablePendingWhere(tenantId),
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r) => r.id);
  }

  static async findTenantById(userId: string) {
    return prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, tenantId: true, tenant: { select: { code: true } } },
    });
  }

  static async setTenant(userId: string, tenantId: string) {
    return bustUsersList(
      await prisma.user.update({
        where: { id: userId },
        data: { tenantId },
        select: { id: true, tenant: { select: { code: true, name: true } } },
      })
    );
  }

  static async setApprovalStatus(userId: string, status: ApprovalStatus, reason: string | null) {
    const user = await prisma.user.update({
      where: { id: userId },
      data: { approvalStatus: status, denialReason: status === "DENIED" ? reason : null },
      select: {
        id: true,
        name: true,
        username: true,
        email: true,
        role: true,
        provider: true,
        isEmailVerified: true,
        approvalStatus: true,
        denialReason: true,
        createdAt: true,
        lastLoginAt: true,
      },
    });
    return bustUsersList(user);
  }
}
