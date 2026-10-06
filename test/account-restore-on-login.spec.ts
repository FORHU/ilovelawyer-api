/** Option A of self-service account deletion: a completed sign-in during the grace period
 * restores the account (AccountDeletionSvc.restoreOnSignIn), through every AuthSvc path that
 * issues a session — and never through a failed sign-in or a silent refresh. Scheduling a
 * deletion signs the user out everywhere, so returning always goes through one of those paths.
 *
 * No live Postgres: AuthRepo, NotificationSvc, verifyGoogleToken, mailer's sendEmail and
 * template's renderTemplate are monkeypatched on their CommonJS module objects, same idiom as
 * test/auth-google.spec.ts.
 */
import { expect } from "chai";
import { describe, it, before, beforeEach, afterEach } from "mocha";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import AuthSvc from "../src/services/auth.service";
import UsersSvc from "../src/services/users.service";
import AuthRepo from "../src/repositories/auth.repository";
import NotificationSvc from "../src/services/notification.service";
import * as googleTokenModule from "../src/utils/googleToken";
import * as mailerModule from "../src/utils/mailer";
import * as templateModule from "../src/utils/template";
import { REFRESH_TOKEN_SECRET } from "../src/config";

const PASSWORD = "Correct-horse-1";
const SCHEDULED = new Date("2026-10-01T00:00:00Z");

function stash<T extends object>(target: T, keys: string[]) {
  const saved = keys.map((k) => [k, (target as any)[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

async function statusOf(promise: Promise<unknown>): Promise<number | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err: any) {
    return err.status ?? err.statusCode;
  }
}

describe("Restore a scheduled account on sign-in", () => {
  let passwordHash: string;
  let restore: (() => void)[];
  let user: Record<string, any>;
  let cleared: string[];
  let clearResult: boolean;
  let emails: { subject: string; html: string }[];
  let notifications: any[];
  let sessionsCreated: string[];
  let sessionsRevoked: string[];

  before(async () => {
    passwordHash = await bcrypt.hash(PASSWORD, 4);
  });

  beforeEach(() => {
    cleared = [];
    clearResult = true;
    emails = [];
    notifications = [];
    sessionsCreated = [];
    sessionsRevoked = [];
    user = {
      id: "user-1",
      email: "jane@firm.com",
      name: "Jane",
      password: passwordHash,
      provider: null,
      role: "USER",
      googleId: null,
      isEmailVerified: true,
      mustChangePassword: false,
      approvalStatus: "ACTIVE",
      deletionRequestedAt: SCHEDULED,
    };

    restore = [
      stash(AuthRepo, [
        "findByEmail",
        "findByGoogleId",
        "findById",
        "findByIdWithPasswordHash",
        "clearDeletionRequestIfSet",
        "createSession",
        "updateLastLogin",
        "deleteSessionsByUserId",
        "consumeLoginLinkToken",
        "consumeResetToken",
        "updatePasswordAndClearMustChange",
        "findByRefreshToken",
        "deleteByRefreshToken",
        "setDeletionRequested",
        "linkGoogleId",
      ]),
      stash(NotificationSvc, ["create"]),
      stash(googleTokenModule, ["default"]),
      stash(mailerModule, ["sendEmail"]),
      stash(templateModule, ["renderTemplate"]),
    ];

    (AuthRepo as any).findByEmail = async () => ({ ...user });
    (AuthRepo as any).findByGoogleId = async () => ({ ...user, googleId: "sub-1", password: null, provider: "google" });
    (AuthRepo as any).findById = async (id: string) => ({ ...user, id });
    (AuthRepo as any).findByIdWithPasswordHash = async (id: string) => ({ id, password: user.password, provider: user.provider });
    (AuthRepo as any).clearDeletionRequestIfSet = async (id: string) => {
      cleared.push(id);
      if (clearResult) user.deletionRequestedAt = null;
      return clearResult;
    };
    (AuthRepo as any).createSession = async (id: string) => void sessionsCreated.push(id);
    (AuthRepo as any).updateLastLogin = async () => {};
    (AuthRepo as any).deleteSessionsByUserId = async (id: string) => void sessionsRevoked.push(id);
    (AuthRepo as any).consumeLoginLinkToken = async () => "user-1";
    (AuthRepo as any).consumeResetToken = async () => "user-1";
    (AuthRepo as any).updatePasswordAndClearMustChange = async () => {};
    (AuthRepo as any).linkGoogleId = async () => true;
    (NotificationSvc as any).create = async (n: any) => void notifications.push(n);
    (googleTokenModule as any).default = async () => ({ googleId: "sub-1", email: "jane@firm.com", isEmailVerified: true });
    (templateModule as any).renderTemplate = async (name: string) => name;
    (mailerModule as any).sendEmail = async (mail: { subject: string; html: string }) => void emails.push(mail);
  });

  afterEach(() => restore.forEach((r) => r()));

  function expectRestored(result: { deletionCancelled?: boolean }) {
    expect(result.deletionCancelled).to.equal(true);
    expect(cleared).to.deep.equal(["user-1"]);
    // Linking also sends its own "Google connected" email; exactly one is the restore notice.
    expect(emails.filter((e) => e.html === "account-deletion-restored")).to.have.length(1);
    expect(notifications).to.have.length(1);
    expect(notifications[0]).to.include({ userId: "user-1", type: "SYSTEM" });
  }

  describe("every sign-in path restores a scheduled account", () => {
    it("password login", async () => {
      const result = await AuthSvc.login("jane@firm.com", PASSWORD);
      expectRestored(result);
      expect(result.user).to.include({ deletionRequestedAt: null });
    });

    it("forced password update", async () => {
      user.mustChangePassword = true;
      expectRestored(await AuthSvc.updateRequiredPassword("jane@firm.com", PASSWORD, "New-password-2"));
    });

    it("Google sign-in (returning user)", async () => {
      expectRestored(await AuthSvc.loginWithGoogle("id-token"));
    });

    it("Google account linking", async () => {
      expectRestored(await AuthSvc.linkGoogle("id-token", PASSWORD));
    });

    it("magic login link", async () => {
      expectRestored(await AuthSvc.consumeLoginLink("good-token"));
    });

    it("password reset", async () => {
      expectRestored(await AuthSvc.resetPassword("reset-token", "New-password-2"));
    });
  });

  it("does nothing for an account with no deletion scheduled", async () => {
    user.deletionRequestedAt = null;
    const result = await AuthSvc.login("jane@firm.com", PASSWORD);
    expect(result.deletionCancelled).to.equal(false);
    expect(cleared).to.have.length(0);
    expect(emails).to.have.length(0);
    expect(notifications).to.have.length(0);
  });

  describe("a sign-in that doesn't complete leaves the deletion scheduled", () => {
    it("wrong password", async () => {
      expect(await statusOf(AuthSvc.login("jane@firm.com", "wrong-password"))).to.equal(401);
      expect(cleared).to.have.length(0);
    });

    it("unverified email", async () => {
      user.isEmailVerified = false;
      expect(await statusOf(AuthSvc.login("jane@firm.com", PASSWORD))).to.equal(403);
      expect(cleared).to.have.length(0);
    });

    it("the 428 forced-password-update step", async () => {
      user.mustChangePassword = true;
      expect(await statusOf(AuthSvc.login("jane@firm.com", PASSWORD))).to.equal(428);
      expect(cleared).to.have.length(0);
    });
  });

  it("a silent token refresh never restores", async () => {
    const token = jwt.sign({ userId: "user-1", remember: true }, REFRESH_TOKEN_SECRET);
    (AuthRepo as any).findByRefreshToken = async () => ({ userId: "user-1", refreshToken: token });
    (AuthRepo as any).deleteByRefreshToken = async () => {};
    await AuthSvc.refresh(token);
    expect(cleared).to.have.length(0);
  });

  it("sends one email and one notification when two sign-ins race", async () => {
    await AuthSvc.login("jane@firm.com", PASSWORD);
    // The second sign-in read the row before the first one cleared it, but loses the conditional update.
    user.deletionRequestedAt = SCHEDULED;
    clearResult = false;
    const second = await AuthSvc.login("jane@firm.com", PASSWORD);
    expect(second.deletionCancelled).to.equal(false);
    expect(emails).to.have.length(1);
    expect(notifications).to.have.length(1);
  });

  it("still signs the user in when the restored email or notification fails", async () => {
    (mailerModule as any).sendEmail = async () => {
      throw new Error("smtp down");
    };
    (NotificationSvc as any).create = async () => {
      throw new Error("db hiccup");
    };
    const result = await AuthSvc.login("jane@firm.com", PASSWORD);
    expect(result.deletionCancelled).to.equal(true);
    expect(sessionsCreated).to.deep.equal(["user-1"]);
  });

  it("fails the sign-in when the restore itself fails, so no session is issued", async () => {
    (AuthRepo as any).clearDeletionRequestIfSet = async () => {
      throw new Error("db down");
    };
    let threw = false;
    try {
      await AuthSvc.login("jane@firm.com", PASSWORD);
    } catch {
      threw = true;
    }
    expect(threw).to.equal(true);
    expect(sessionsCreated).to.have.length(0);
  });

  it("scheduling a deletion revokes every session", async () => {
    user.deletionRequestedAt = null;
    (AuthRepo as any).setDeletionRequested = async (_id: string, at: Date) => ({ ...user, deletionRequestedAt: at });
    await UsersSvc.requestDeletion("user-1", PASSWORD);
    expect(sessionsRevoked).to.deep.equal(["user-1"]);
    expect(emails.map((e) => e.html)).to.deep.equal(["account-deletion-scheduled"]);
  });

  describe("scheduling a deletion requires the password", () => {
    let scheduled: string[];

    beforeEach(() => {
      scheduled = [];
      user.deletionRequestedAt = null;
      (AuthRepo as any).setDeletionRequested = async (id: string, at: Date) => {
        scheduled.push(id);
        return { ...user, deletionRequestedAt: at };
      };
    });

    it("refuses a missing or wrong password with a 400, scheduling nothing", async () => {
      expect(await statusOf(UsersSvc.requestDeletion("user-1", undefined))).to.equal(400);
      expect(await statusOf(UsersSvc.requestDeletion("user-1", "Wrong-horse-1"))).to.equal(400);
      expect(scheduled).to.have.length(0);
      expect(sessionsRevoked).to.have.length(0);
      expect(emails).to.have.length(0);
    });

    it("needs no password from a Google SSO account", async () => {
      user.provider = "google";
      user.password = null;
      await UsersSvc.requestDeletion("user-1", undefined);
      expect(scheduled).to.deep.equal(["user-1"]);
    });
  });
});
