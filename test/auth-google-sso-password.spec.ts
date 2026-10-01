/** Google SSO accounts (provider "google") sign in with Google only: password sign-in, the
 * forced password update, account linking by password, forgot/reset password and password
 * change are all refused for them — even when an older build let one set a password through the
 * reset flow. Password accounts, including ones that later linked Google, are unaffected.
 *
 * No live Postgres: AuthRepo, prisma.user, mailer's sendEmail and template's renderTemplate are
 * monkeypatched, same idiom as test/auth-google.spec.ts and test/users-list-cache.spec.ts.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import bcrypt from "bcrypt";
import prisma from "../src/lib/prisma";
import AuthSvc from "../src/services/auth.service";
import UsersSvc from "../src/services/users.service";
import AuthRepo from "../src/repositories/auth.repository";
import OrganizationMemberRepo from "../src/repositories/organization-member.repository";
import * as googleTokenModule from "../src/utils/googleToken";
import * as mailerModule from "../src/utils/mailer";
import * as templateModule from "../src/utils/template";
import HttpError from "../src/utils/http-error";
import { isGoogleSsoAccount } from "../src/utils/auth.utils";

function stash<T extends object>(target: T, keys: (keyof T)[]) {
  const saved = keys.map((k) => [k, target[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

async function expectHttpError(promise: Promise<unknown>, status: number) {
  try {
    await promise;
  } catch (err) {
    expect(err).to.be.instanceOf(HttpError);
    expect((err as HttpError).statusCode).to.equal(status);
    return;
  }
  throw new Error(`expected HttpError ${status}`);
}

const PASSWORD = "Correct-horse-1";
const passwordHash = bcrypt.hashSync(PASSWORD, 4);

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    email: "jane@firm.com",
    password: passwordHash,
    name: "Jane",
    role: "USER",
    provider: null as string | null,
    googleId: null as string | null,
    isEmailVerified: true,
    approvalStatus: "ACTIVE",
    mustChangePassword: false,
    tenant: null,
    ...overrides,
  };
}

// A Google SSO account that still holds a password set through the old reset flow.
const googleAccount = () => account({ provider: "google", googleId: "sub-1" });

describe("Google SSO accounts have no password sign-in or recovery", () => {
  let restore: (() => void)[];
  let found: ReturnType<typeof account> | null;
  let resetTokensSet: string[];
  let sessions: string[];
  let sent: { template: string; vars: Record<string, string>; to: string }[];
  let lastTemplate: { name: string; vars: Record<string, string> };

  beforeEach(() => {
    found = null;
    resetTokensSet = [];
    sessions = [];
    sent = [];

    restore = [
      stash(AuthRepo as any, [
        "findByEmail",
        "findByIdWithPasswordHash",
        "setResetToken",
        "createSession",
        "updateLastLogin",
        "findById",
        "linkGoogleId",
        "updatePasswordAndClearMustChange",
      ]),
      stash(OrganizationMemberRepo as any, ["findAnyForUser"]),
      stash(googleTokenModule as any, ["default"]),
      stash(mailerModule as any, ["sendEmail"]),
      stash(templateModule as any, ["renderTemplate"]),
    ];

    (AuthRepo as any).findByEmail = async () => found;
    (AuthRepo as any).findByIdWithPasswordHash = async () => found;
    (AuthRepo as any).setResetToken = async (userId: string) => resetTokensSet.push(userId);
    (AuthRepo as any).createSession = async (userId: string) => sessions.push(userId);
    (AuthRepo as any).updateLastLogin = async () => {};
    (AuthRepo as any).findById = async (id: string) => ({ id });
    (AuthRepo as any).linkGoogleId = async () => true;
    (AuthRepo as any).updatePasswordAndClearMustChange = async () => {};
    (OrganizationMemberRepo as any).findAnyForUser = async () => null;
    (googleTokenModule as any).default = async () => ({
      googleId: "sub-2",
      email: "jane@firm.com",
      name: "Jane",
      isEmailVerified: true,
    });
    (templateModule as any).renderTemplate = async (name: string, vars: Record<string, string>) => {
      lastTemplate = { name, vars };
      return name;
    };
    (mailerModule as any).sendEmail = async ({ to }: { to: string }) => {
      sent.push({ template: lastTemplate.name, vars: lastTemplate.vars, to });
    };
  });

  afterEach(() => restore.forEach((r) => r()));

  describe("login", () => {
    it("rejects a Google SSO account with the generic 401, even with its correct password", async () => {
      found = googleAccount();
      await expectHttpError(AuthSvc.login("jane@firm.com", PASSWORD), 401);
      expect(sessions).to.be.empty;
    });

    it("still signs in a password account, including one that linked Google", async () => {
      found = account({ googleId: "sub-1" });
      await AuthSvc.login("jane@firm.com", PASSWORD);
      expect(sessions).to.deep.equal(["user-1"]);
    });
  });

  it("updateRequiredPassword rejects a Google SSO account", async () => {
    found = googleAccount();
    found.mustChangePassword = true;
    await expectHttpError(AuthSvc.updateRequiredPassword("jane@firm.com", PASSWORD, "New-password-2"), 401);
    expect(sessions).to.be.empty;
  });

  it("linkGoogle won't accept a Google SSO account's password as proof", async () => {
    found = googleAccount();
    await expectHttpError(AuthSvc.linkGoogle("token", PASSWORD), 401);
    expect(sessions).to.be.empty;
  });

  describe("forgotPassword", () => {
    it("emails a Google SSO account a 'use Google' note instead of a reset link", async () => {
      found = { ...googleAccount(), tenant: { code: "PH", name: "Philippines" } as any };
      const result = await AuthSvc.forgotPassword("jane@firm.com");

      expect(resetTokensSet).to.be.empty;
      expect(sent).to.have.length(1);
      expect(sent[0].template).to.equal("google-sign-in");
      expect(sent[0].to).to.equal("jane@firm.com");
      expect(sent[0].vars.loginLink).to.match(/\/login$/);
      expect(result).to.deep.equal({ message: "If the email exists, a reset link will be sent" });
    });

    it("still sends a reset link to a password account", async () => {
      found = account();
      await AuthSvc.forgotPassword("jane@firm.com");
      expect(resetTokensSet).to.deep.equal(["user-1"]);
      expect(sent.map((s) => s.template)).to.deep.equal(["reset-password"]);
    });

    it("answers the same for an unknown email", async () => {
      const result = await AuthSvc.forgotPassword("nobody@firm.com");
      expect(sent).to.be.empty;
      expect(result).to.deep.equal({ message: "If the email exists, a reset link will be sent" });
    });
  });

  describe("UsersSvc.changePassword", () => {
    it("refuses a Google SSO account", async () => {
      found = googleAccount();
      await expectHttpError(UsersSvc.changePassword("user-1", PASSWORD, "New-password-2"), 400);
    });

    it("still works for a password account", async () => {
      found = account();
      await UsersSvc.changePassword("user-1", PASSWORD, "New-password-2");
    });
  });
});

describe("AuthRepo — reset tokens and hasPassword for Google SSO accounts", () => {
  let restore: () => void;
  let wheres: any[];

  beforeEach(() => {
    wheres = [];
    const users = prisma.user as any;
    restore = stash(users, ["findFirst", "updateMany", "findUnique"]);
    users.findFirst = async ({ where }: any) => {
      wheres.push(where);
      return { id: "user-1" };
    };
    users.updateMany = async ({ where }: any) => {
      wheres.push(where);
      return { count: 0 };
    };
  });

  afterEach(() => restore());

  it("only matches reset tokens on password accounts (provider null or not google)", async () => {
    await AuthRepo.isResetTokenValid("token");
    await AuthRepo.consumeResetToken("token", "hash");

    expect(wheres).to.have.length(3);
    for (const where of wheres) {
      expect(where.OR).to.deep.equal([{ provider: null }, { provider: { not: "google" } }]);
    }
  });

  it("reports hasPassword false for a Google SSO account that holds a password", async () => {
    (prisma.user as any).findUnique = async () => ({ id: "user-1", provider: "google", password: "hash" });
    expect(await AuthRepo.findById("user-1")).to.include({ hasPassword: false });

    (prisma.user as any).findUnique = async () => ({ id: "user-1", provider: null, password: "hash" });
    expect(await AuthRepo.findById("user-1")).to.include({ hasPassword: true });
  });

  it("isGoogleSsoAccount is true only for provider google", () => {
    expect(isGoogleSsoAccount({ provider: "google" })).to.equal(true);
    expect(isGoogleSsoAccount({ provider: null })).to.equal(false);
    expect(isGoogleSsoAccount({ provider: "email" })).to.equal(false);
  });
});

describe("emailLinkOrigin / requestFrontendOrigin", () => {
  // CLIENT_URL is read from .env at import; these use origins present in every dev .env shape
  // only through the function contract, so they stub CLIENT_URL's contents directly.
  const config = require("../src/config");
  const saved = [...config.CLIENT_URL];
  const { emailLinkOrigin, requestFrontendOrigin } = require("../src/utils/tenant-host");

  beforeEach(() => {
    config.CLIENT_URL.splice(0, config.CLIENT_URL.length,
      "http://localhost:3002",
      "http://uk.ilovelawyer.local:3002",
      "https://uk-local.ilovelawyer.com:3002",
      "https://ph-local.ilovelawyer.com:3002",
    );
  });
  afterEach(() => config.CLIENT_URL.splice(0, config.CLIENT_URL.length, ...saved));

  it("uses the allow-listed site the request came from, when it belongs to the account's tenant", () => {
    expect(emailLinkOrigin("UK", "https://uk-local.ilovelawyer.com:3002")).to.equal("https://uk-local.ilovelawyer.com:3002");
    expect(emailLinkOrigin(null, "https://ph-local.ilovelawyer.com:3002")).to.equal("https://ph-local.ilovelawyer.com:3002");
  });

  it("falls back to the tenant's configured origin for another tenant's site or no origin", () => {
    expect(emailLinkOrigin("UK", "https://ph-local.ilovelawyer.com:3002")).to.equal("http://uk.ilovelawyer.local:3002");
    expect(emailLinkOrigin("UK", null)).to.equal("http://uk.ilovelawyer.local:3002");
  });

  it("only trusts Origin/Referer values listed in CLIENT_URL", () => {
    const req = (headers: Record<string, string>) => ({ headers }) as any;
    expect(requestFrontendOrigin(req({ origin: "https://uk-local.ilovelawyer.com:3002" }))).to.equal("https://uk-local.ilovelawyer.com:3002");
    expect(requestFrontendOrigin(req({ referer: "https://uk-local.ilovelawyer.com:3002/login?x=1" }))).to.equal("https://uk-local.ilovelawyer.com:3002");
    expect(requestFrontendOrigin(req({ origin: "https://evil.example" }))).to.equal(null);
    expect(requestFrontendOrigin(req({}))).to.equal(null);
  });
});
