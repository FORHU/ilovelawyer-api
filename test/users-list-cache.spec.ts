/** The admin users list (AdminSvc.listUsers) is cached per USERS_LIST_VERSION_KEY version, and
 * AuthRepo bumps that version on every user write the list can show — signup, Google signup,
 * login, email verification, password change/reset, profile edit, approval status, tenant,
 * deletion — and skips writes it can't (tokens, OTP codes).
 *
 * No live Postgres/Redis: prisma.user's methods and redis are monkeypatched, same idiom as
 * test/admin-change-tenant.spec.ts.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import prisma from "../src/lib/prisma";
import AuthRepo from "../src/repositories/auth.repository";
import { redis } from "../src/lib/redis";
import { USERS_LIST_VERSION_KEY } from "../src/constants";

function stash<T extends object>(target: T, keys: (keyof T)[]) {
  const saved = keys.map((k) => [k, target[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

const ROW = { id: "user-1", password: "hash" };

describe("AuthRepo — admin users-list cache busting", () => {
  let restore: (() => void)[];
  let busts: string[];
  let matched: number;
  let found: object | null;

  beforeEach(() => {
    busts = [];
    matched = 1;
    found = { id: "user-1" };
    const users = prisma.user as any;

    restore = [
      stash(users, ["create", "update", "delete", "deleteMany", "updateMany", "findFirst", "findUnique"]),
      stash(redis, ["incr"]),
    ];

    users.create = async () => ROW;
    users.update = async () => ROW;
    users.delete = async () => ROW;
    users.deleteMany = async () => ({ count: matched });
    users.updateMany = async () => ({ count: matched });
    users.findFirst = async () => found;
    users.findUnique = async () => null;
    (redis as any).incr = async (key: string) => busts.push(key);
  });

  afterEach(() => restore.forEach((r) => r()));

  const busting: [string, () => Promise<unknown>][] = [
    ["createUser", () => AuthRepo.createUser({ username: "u", email: "e@x.com", password: "h", name: "n" })],
    ["createGoogleUser", () => AuthRepo.createGoogleUser("e@x.com", "g-1", "n", null)],
    ["updateLastLogin", () => AuthRepo.updateLastLogin("user-1")],
    ["updatePasswordAndClearMustChange", () => AuthRepo.updatePasswordAndClearMustChange("user-1", "h")],
    ["updateProfile", () => AuthRepo.updateProfile("user-1", { name: "n" })],
    ["deleteUser", () => AuthRepo.deleteUser("user-1")],
    ["deleteUnverifiedPendingUser", () => AuthRepo.deleteUnverifiedPendingUser("e@x.com")],
    ["markEmailVerified", () => AuthRepo.markEmailVerified("user-1")],
    ["consumeEmailVerificationOtp", () => AuthRepo.consumeEmailVerificationOtp("e@x.com", "123456")],
    ["consumeResetToken", () => AuthRepo.consumeResetToken("token", "h")],
    ["setApprovalStatus", () => AuthRepo.setApprovalStatus("user-1", "ACTIVE", null)],
    ["setTenant", () => AuthRepo.setTenant("user-1", "tenant-uk")],
  ];

  for (const [name, call] of busting) {
    it(`${name} bumps the users-list version`, async () => {
      await call();
      expect(busts).to.deep.equal([USERS_LIST_VERSION_KEY]);
    });
  }

  it("still returns the write's own result", async () => {
    expect(await AuthRepo.updateLastLogin("user-1")).to.equal(ROW);
    expect(await AuthRepo.consumeResetToken("token", "h")).to.equal("user-1");
  });

  it("doesn't bump when a conditional write matched nothing", async () => {
    matched = 0;
    await AuthRepo.deleteUnverifiedPendingUser("e@x.com");
    await AuthRepo.consumeResetToken("token", "h");
    await AuthRepo.consumeEmailVerificationOtp("e@x.com", "123456");
    expect(busts).to.have.length(0);
  });

  it("doesn't bump for writes the list doesn't show", async () => {
    await AuthRepo.setResetToken("user-1", "token", new Date());
    await AuthRepo.setEmailVerificationCode("user-1", "123456", new Date());
    await AuthRepo.incrementEmailVerificationAttempts("user-1");
    await AuthRepo.setLoginLinkToken("user-1", "token", new Date());
    expect(busts).to.have.length(0);
  });
});
