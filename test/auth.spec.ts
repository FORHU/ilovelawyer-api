/** Task 8: threading an optional `caseInviteToken` through the four auth paths that log an
 * account in as verified — verifyOtp, login, and both branches of loginWithGoogle — so a client
 * can invite a specific lawyer onto their case and have it attach the moment that lawyer signs
 * up or signs in. CaseLawyerInviteSvc.redeem only returns an error object (never throws) for its
 * own enumerated outcomes; it can still throw for anything else, and that must never block the
 * surrounding auth flow (see AuthSvc.redeemCaseInvite).
 *
 * No live Postgres: repos, CaseLawyerInviteSvc, mailer, template and googleToken are
 * monkeypatched on their CommonJS module objects, same idiom as
 * test/signup-auto-approve.spec.ts and test/account-restore-on-login.spec.ts.
 */
import { expect } from "chai";
import { describe, it, before, beforeEach, afterEach } from "mocha";
import bcrypt from "bcrypt";
import AuthSvc from "../src/services/auth.service";
import AuthRepo from "../src/repositories/auth.repository";
import CaseLawyerInviteSvc from "../src/services/case-lawyer-invite.service";
import OrganizationEmailInviteRepo from "../src/repositories/organization-email-invite.repository";
import * as googleTokenModule from "../src/utils/googleToken";
import * as mailerModule from "../src/utils/mailer";
import * as templateModule from "../src/utils/template";

const PASSWORD = "Correct-horse-1";
const TOKEN = "11111111-1111-1111-1111-111111111111";

function stash<T extends object>(target: T, keys: string[]) {
  const saved = keys.map((k) => [k, (target as any)[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

describe("caseInviteToken — threaded through verifyOtp/login/loginWithGoogle", () => {
  let passwordHash: string;
  let restore: (() => void)[];
  let user: Record<string, any>;
  let redeemCalls: { user: { id: string; email: string }; token: string }[];
  let redeemResult: any;
  let redeemError: Error | null;

  before(async () => {
    passwordHash = await bcrypt.hash(PASSWORD, 4);
  });

  beforeEach(() => {
    redeemCalls = [];
    redeemResult = { requestId: "req-1", caseId: "case-1" };
    redeemError = null;
    user = {
      id: "user-1",
      email: "jane@firm.com",
      name: "Jane",
      password: passwordHash,
      role: "LAWYER",
      googleId: null,
      isEmailVerified: true,
      mustChangePassword: false,
      approvalStatus: "ACTIVE",
      deletionRequestedAt: null,
      emailVerificationCode: "123456",
      emailVerificationExpiry: new Date(Date.now() + 60_000),
      emailVerificationAttempts: 0,
    };

    restore = [
      stash(AuthRepo, [
        "findByEmail",
        "findByGoogleId",
        "findById",
        "markEmailVerified",
        "incrementEmailVerificationAttempts",
        "invalidateEmailVerificationCode",
        "updateLastLogin",
        "createSession",
        "createGoogleUser",
      ]),
      stash(OrganizationEmailInviteRepo, ["claim"]),
      stash(CaseLawyerInviteSvc, ["redeem"]),
      stash(googleTokenModule, ["default"]),
      stash(mailerModule, ["sendEmail"]),
      stash(templateModule, ["renderTemplate"]),
    ];

    (AuthRepo as any).findByEmail = async (email: string) => (email === user.email ? { ...user } : null);
    (AuthRepo as any).findByGoogleId = async () => (user.googleId ? { ...user } : null);
    (AuthRepo as any).findById = async (id: string) => ({ ...user, id });
    (AuthRepo as any).markEmailVerified = async () => {
      user.isEmailVerified = true;
    };
    (AuthRepo as any).incrementEmailVerificationAttempts = async () => {};
    (AuthRepo as any).invalidateEmailVerificationCode = async () => {};
    (AuthRepo as any).updateLastLogin = async () => {};
    (AuthRepo as any).createSession = async () => {};
    (AuthRepo as any).createGoogleUser = async ({ email, name }: { email: string; name: string }) => {
      user = { ...user, email, name, googleId: "g-1", isEmailVerified: true };
      return user;
    };
    (OrganizationEmailInviteRepo as any).claim = async () => false;
    (CaseLawyerInviteSvc as any).redeem = async (redeemer: { id: string; email: string }, token: string) => {
      redeemCalls.push({ user: redeemer, token });
      if (redeemError) throw redeemError;
      return redeemResult;
    };
    (googleTokenModule as any).default = async () => ({
      googleId: "g-1",
      email: user.email,
      name: user.name,
      picture: null,
      isEmailVerified: true,
    });
    (mailerModule as any).sendEmail = async () => {};
    (templateModule as any).renderTemplate = async () => "<html></html>";
  });

  afterEach(() => restore.forEach((r) => r()));

  describe("verifyOtp", () => {
    it("with a valid caseInviteToken, attaches the invite and returns requestId/caseId", async () => {
      user.isEmailVerified = false;
      const result = await AuthSvc.verifyOtp(user.email, "123456", TOKEN);
      expect(redeemCalls).to.have.length(1);
      expect(redeemCalls[0]).to.include({ token: TOKEN });
      expect(redeemCalls[0].user).to.include({ id: "user-1", email: "jane@firm.com" });
      expect(result.caseLawyerInvite).to.deep.equal({ requestId: "req-1", caseId: "case-1" });
    });

    it("with an expired caseInviteToken, still verifies the account and returns the error in caseLawyerInvite", async () => {
      user.isEmailVerified = false;
      redeemResult = { error: "INVITE_EXPIRED" };
      const result = await AuthSvc.verifyOtp(user.email, "123456", TOKEN);
      expect(result.user).to.include({ isEmailVerified: true });
      expect(result.caseLawyerInvite).to.deep.equal({ error: "INVITE_EXPIRED" });
    });

    it("with no caseInviteToken, never calls redeem and returns caseLawyerInvite: null", async () => {
      user.isEmailVerified = false;
      const result = await AuthSvc.verifyOtp(user.email, "123456");
      expect(redeemCalls).to.have.length(0);
      expect(result.caseLawyerInvite).to.equal(null);
    });

    it("when redeem throws, verification still succeeds and caseLawyerInvite is INVITE_NOT_FOUND", async () => {
      user.isEmailVerified = false;
      redeemError = new Error("db exploded");
      const result = await AuthSvc.verifyOtp(user.email, "123456", TOKEN);
      expect(result.user).to.include({ isEmailVerified: true });
      expect(result.caseLawyerInvite).to.deep.equal({ error: "INVITE_NOT_FOUND" });
    });
  });

  describe("login (existing lawyer, not signup)", () => {
    it("with a valid caseInviteToken, also attaches the lawyer", async () => {
      const result = await AuthSvc.login(user.email, PASSWORD, false, null, TOKEN);
      expect(redeemCalls).to.have.length(1);
      expect(redeemCalls[0]).to.include({ token: TOKEN });
      expect(redeemCalls[0].user).to.include({ id: "user-1", email: "jane@firm.com" });
      expect(result.caseLawyerInvite).to.deep.equal({ requestId: "req-1", caseId: "case-1" });
    });

    it("with no caseInviteToken, never calls redeem and returns caseLawyerInvite: null", async () => {
      const result = await AuthSvc.login(user.email, PASSWORD, false, null);
      expect(redeemCalls).to.have.length(0);
      expect(result.caseLawyerInvite).to.equal(null);
    });

    it("when redeem throws, login still succeeds and caseLawyerInvite is INVITE_NOT_FOUND", async () => {
      redeemError = new Error("db exploded");
      const result = await AuthSvc.login(user.email, PASSWORD, false, null, TOKEN);
      expect(result.user).to.exist;
      expect(result.caseLawyerInvite).to.deep.equal({ error: "INVITE_NOT_FOUND" });
    });
  });

  describe("loginWithGoogle", () => {
    it("signup branch: with a valid caseInviteToken, attaches the invite for the new account", async () => {
      // A brand-new Google identity: no existing row under this googleId or this email.
      (AuthRepo as any).findByGoogleId = async () => null;
      (googleTokenModule as any).default = async () => ({
        googleId: "g-new",
        email: "new-lawyer@example.com",
        name: "New Lawyer",
        picture: null,
        isEmailVerified: true,
      });
      const result = await AuthSvc.loginWithGoogle("id-token", true, null, true, TOKEN);
      expect(redeemCalls).to.have.length(1);
      expect(redeemCalls[0]).to.include({ token: TOKEN });
      expect(result.caseLawyerInvite).to.deep.equal({ requestId: "req-1", caseId: "case-1" });
      expect(result.isNewAccount).to.equal(true);
    });

    it("sign-in branch (returning user): with a valid caseInviteToken, attaches the invite", async () => {
      user.googleId = "g-1";
      (AuthRepo as any).findByGoogleId = async () => ({ ...user });
      const result = await AuthSvc.loginWithGoogle("id-token", true, null, false, TOKEN);
      expect(redeemCalls).to.have.length(1);
      expect(result.caseLawyerInvite).to.deep.equal({ requestId: "req-1", caseId: "case-1" });
      expect(result.isNewAccount).to.equal(false);
    });

    it("with no caseInviteToken, never calls redeem and returns caseLawyerInvite: null", async () => {
      user.googleId = "g-1";
      (AuthRepo as any).findByGoogleId = async () => ({ ...user });
      const result = await AuthSvc.loginWithGoogle("id-token", true, null, false);
      expect(redeemCalls).to.have.length(0);
      expect(result.caseLawyerInvite).to.equal(null);
    });

    it("when redeem throws on the sign-in branch, login still succeeds and caseLawyerInvite is INVITE_NOT_FOUND", async () => {
      user.googleId = "g-1";
      (AuthRepo as any).findByGoogleId = async () => ({ ...user });
      redeemError = new Error("db exploded");
      const result = await AuthSvc.loginWithGoogle("id-token", true, null, false, TOKEN);
      expect(result.user).to.exist;
      expect(result.caseLawyerInvite).to.deep.equal({ error: "INVITE_NOT_FOUND" });
    });
  });
});
