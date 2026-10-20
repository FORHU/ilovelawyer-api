/** ilovelawyer-app (LAWYER) and the client app (USER) share this API: the X-Client-App header
 * picks a new account's role, an account signs in only to its own app (ADMIN to either), and a
 * client account is active as soon as its email is verified, while a lawyer still waits for
 * admin approval. See src/utils/client-app.ts.
 *
 * No live Postgres: repositories are monkeypatched on their CommonJS module objects, same idiom
 * as test/account-restore-on-login.spec.ts.
 */
import { expect } from "chai";
import { describe, it, before, after, beforeEach, afterEach } from "mocha";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import type { Request } from "express";
import AuthSvc from "../src/services/auth.service";
import AuthRepo from "../src/repositories/auth.repository";
import OrganizationEmailInviteRepo from "../src/repositories/organization-email-invite.repository";
import TenantSettingSvc from "../src/services/tenant-setting.service";
import TenantRepo from "../src/repositories/tenant.repository";
import { runWithRequestContext } from "../src/lib/request-context";
import { ClientApp, resolveClientApp } from "../src/utils/client-app";
import * as mailerModule from "../src/utils/mailer";
import * as templateModule from "../src/utils/template";
import { REFRESH_TOKEN_SECRET, USER_APP_URL, CLIENT_URL } from "../src/config";
import { CLIENT_TERMS_VERSION, TERMS_VERSION } from "../src/constants/auth.constants";
import { emailLinkOriginForAccount, resolveTenantCodeFromHost } from "../src/utils/tenant-host";

const PASSWORD = "Correct-horse-1";

function stash<T extends object>(target: T, keys: string[]) {
  const saved = keys.map((k) => [k, (target as any)[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

function inApp<T>(clientApp: ClientApp, fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext(
    {
      requestId: "req-1",
      ip: null,
      userAgent: null,
      userId: () => null,
      organizationId: () => null,
      tenantCode: () => null,
      clientApp,
    },
    fn,
  );
}

async function errorOf(promise: Promise<unknown>): Promise<{ status?: number; code?: string } | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err: any) {
    return { status: err.status ?? err.statusCode, code: err.code };
  }
}

describe("Client app decides the account role", () => {
  describe("resolveClientApp", () => {
    const req = (headers: Record<string, string>) => ({ headers }) as unknown as Request;

    it("reads X-Client-App: user as the client app", () => {
      expect(resolveClientApp(req({ "x-client-app": "user" }))).to.equal("user");
    });

    it("treats no header, or any other value, as the lawyer app", () => {
      expect(resolveClientApp(req({}))).to.equal("lawyer");
      expect(resolveClientApp(req({ "x-client-app": "lawyer" }))).to.equal("lawyer");
      expect(resolveClientApp(req({ "x-client-app": "USER" }))).to.equal("lawyer");
    });
  });

  describe("sign-in", () => {
    let passwordHash: string;
    let restore: (() => void)[];
    let user: Record<string, any>;
    let sessionsCreated: string[];
    let tokensDeleted: string[];

    before(async () => {
      passwordHash = await bcrypt.hash(PASSWORD, 4);
    });

    beforeEach(() => {
      sessionsCreated = [];
      tokensDeleted = [];
      user = {
        id: "user-1",
        email: "jane@firm.com",
        name: "Jane",
        password: passwordHash,
        provider: null,
        role: "LAWYER",
        googleId: null,
        isEmailVerified: true,
        mustChangePassword: false,
        approvalStatus: "ACTIVE",
        deletionRequestedAt: null,
      };

      restore = [
        stash(AuthRepo, ["findByEmail", "findById", "createSession", "updateLastLogin", "findByRefreshToken", "deleteByRefreshToken", "findTrialState"]),
      ];
      (AuthRepo as any).findByEmail = async () => ({ ...user });
      (AuthRepo as any).findById = async (id: string) => ({ ...user, id });
      (AuthRepo as any).createSession = async (id: string) => void sessionsCreated.push(id);
      (AuthRepo as any).updateLastLogin = async () => {};
      (AuthRepo as any).findByRefreshToken = async (token: string) => ({ token, userId: user.id });
      (AuthRepo as any).deleteByRefreshToken = async (token: string) => void tokensDeleted.push(token);
      (AuthRepo as any).findTrialState = async () => null;
    });

    afterEach(() => restore.forEach((r) => r()));

    const login = () => AuthSvc.login(user.email, PASSWORD);

    it("lets a lawyer into the lawyer app", async () => {
      await inApp("lawyer", login);
      expect(sessionsCreated).to.deep.equal(["user-1"]);
    });

    it("refuses a lawyer in the client app with 409 WRONG_APP", async () => {
      expect(await errorOf(inApp("user", login))).to.deep.equal({ status: 409, code: "WRONG_APP" });
      expect(sessionsCreated).to.be.empty;
    });

    it("lets a client into the client app and refuses it in the lawyer app", async () => {
      user.role = "USER";
      await inApp("user", login);
      expect(sessionsCreated).to.deep.equal(["user-1"]);
      expect(await errorOf(inApp("lawyer", login))).to.deep.equal({ status: 409, code: "WRONG_APP" });
    });

    it("lets an admin in from either app", async () => {
      user.role = "ADMIN";
      await inApp("lawyer", login);
      await inApp("user", login);
      expect(sessionsCreated).to.have.length(2);
    });

    it("won't refresh a lawyer's session from the client app, and keeps the token", async () => {
      const token = jwt.sign({ userId: user.id }, REFRESH_TOKEN_SECRET);
      expect((await errorOf(inApp("user", () => AuthSvc.refresh(token))))?.status).to.equal(401);
      expect(tokensDeleted).to.be.empty;

      await inApp("lawyer", () => AuthSvc.refresh(token));
      expect(tokensDeleted).to.deep.equal([token]);
    });
  });

  describe("signup", () => {
    let restore: (() => void)[];
    let created: { role: string }[];
    let emails: string[];
    let tenantLookups: string[];

    beforeEach(() => {
      created = [];
      emails = [];
      tenantLookups = [];
      restore = [
        stash(AuthRepo, ["findByEmail", "findByUsername", "createUser"]),
        stash(TenantRepo, ["findIdByCode"]),
        stash(TenantSettingSvc, ["isAutoApproveOn"]),
        stash(OrganizationEmailInviteRepo, ["hasLiveInvite"]),
        stash(mailerModule, ["sendEmail"]),
        stash(templateModule, ["renderTemplate"]),
      ];
      (AuthRepo as any).findByEmail = async () => null;
      (AuthRepo as any).findByUsername = async () => null;
      (AuthRepo as any).createUser = async (data: { role: string }) => {
        created.push(data);
        return { id: "new-1", email: "a@b.com", name: "A", ...data };
      };
      (TenantRepo as any).findIdByCode = async (code: string) => {
        tenantLookups.push(code);
        return `tenant-${code}`;
      };
      (TenantSettingSvc as any).isAutoApproveOn = async () => false;
      (OrganizationEmailInviteRepo as any).hasLiveInvite = async () => false;
      (templateModule as any).renderTemplate = async (name: string) => name;
      (mailerModule as any).sendEmail = async (mail: { html: string }) => void emails.push(mail.html);
    });

    afterEach(() => restore.forEach((r) => r()));

    const signup = (requestTenantCode: "PH" | "UK" | null = null) =>
      AuthSvc.signup("a", "a@b.com", "Password123!", "A", requestTenantCode, true);

    it("puts every client in the UK tenant, whatever site it signed up from", async () => {
      await inApp("user", () => signup(null));
      await inApp("user", () => signup("PH"));
      expect(created.map((d: any) => d.tenantId)).to.deep.equal(["tenant-UK", "tenant-UK"]);
    });

    it("still takes a lawyer's tenant from the site, and none from an unknown one", async () => {
      await inApp("lawyer", () => signup("PH"));
      await inApp("lawyer", () => signup(null));
      expect(created.map((d: any) => d.tenantId)).to.deep.equal(["tenant-PH", null]);
      expect(tenantLookups).to.deep.equal(["PH"]);
    });

    it("tells a returning client 'Email already in use', not to go to another tenant's site", async () => {
      (AuthRepo as any).findByEmail = async () => ({ id: "cli-1", role: "USER", tenant: { code: "UK", name: "United Kingdom" } });
      try {
        await inApp("user", () => signup(null));
        expect.fail("signup should have been refused");
      } catch (err: any) {
        expect(err.message).to.equal("Email already in use");
      }
    });

    it("creates a LAWYER from the lawyer app and tells them to wait for approval", async () => {
      await inApp("lawyer", signup);
      expect(created.map((d) => d.role)).to.deep.equal(["LAWYER"]);
      expect(emails).to.deep.equal(["signup-pending"]);
    });

    it("creates a USER from the client app, with no approval wait", async () => {
      await inApp("user", signup);
      expect(created.map((d) => d.role)).to.deep.equal(["USER"]);
      expect(emails).to.be.empty;
    });

    it("records the client Terms version for a client and the lawyer one for a lawyer", async () => {
      await inApp("user", signup);
      await inApp("lawyer", signup);
      expect(created.map((d: any) => d.termsVersion)).to.deep.equal([CLIENT_TERMS_VERSION, TERMS_VERSION]);
    });

    it("refuses a lawyer's email in the client app with EMAIL_REGISTERED_AS_LAWYER", async () => {
      (AuthRepo as any).findByEmail = async () => ({ id: "law-1", role: "LAWYER", tenant: null });
      expect(await errorOf(inApp("user", signup))).to.deep.equal({ status: 409, code: "EMAIL_REGISTERED_AS_LAWYER" });
      expect(created).to.be.empty;
    });

    it("keeps the generic 409 for a client's email in the lawyer app, and for a client signing up twice", async () => {
      (AuthRepo as any).findByEmail = async () => ({ id: "cli-1", role: "USER", tenant: null });
      expect(await errorOf(inApp("lawyer", signup))).to.deep.equal({ status: 409, code: undefined });
      expect(await errorOf(inApp("user", signup))).to.deep.equal({ status: 409, code: undefined });
    });
  });

  describe("password reset", () => {
    let restore: (() => void)[];
    let owner: { id: string; role: string } | null;
    let consumed: string[];
    let sessionsDeleted: string[];

    beforeEach(() => {
      consumed = [];
      sessionsDeleted = [];
      owner = { id: "user-1", role: "LAWYER" };
      restore = [
        stash(AuthRepo, ["findUserByResetToken", "consumeResetToken", "deleteSessionsByUserId", "findById", "createSession"]),
      ];
      (AuthRepo as any).findUserByResetToken = async () => owner;
      (AuthRepo as any).consumeResetToken = async (token: string) => {
        consumed.push(token);
        return owner?.id ?? null;
      };
      (AuthRepo as any).deleteSessionsByUserId = async (id: string) => void sessionsDeleted.push(id);
      (AuthRepo as any).findById = async (id: string) => ({ ...owner, id, email: "a@b.com", name: "A", deletionRequestedAt: null });
      (AuthRepo as any).createSession = async () => {};
    });

    afterEach(() => restore.forEach((r) => r()));

    const reset = () => AuthSvc.resetPassword("reset-token", PASSWORD);

    it("refuses a lawyer's reset link in the client app without spending the token or ending sessions", async () => {
      expect(await errorOf(inApp("user", reset))).to.deep.equal({ status: 409, code: "WRONG_APP" });
      expect(consumed).to.be.empty;
      expect(sessionsDeleted).to.be.empty;
    });

    it("resets a client's password from the client app", async () => {
      owner = { id: "client-1", role: "USER" };
      await inApp("user", reset);
      expect(consumed).to.deep.equal(["reset-token"]);
      expect(sessionsDeleted).to.deep.equal(["client-1"]);
    });

    it("answers 400 for an unknown or expired token", async () => {
      owner = null;
      expect((await errorOf(inApp("user", reset)))?.status).to.equal(400);
    });
  });

  describe("tenant from the client app's host", () => {
    it("never reads a tenant from the client app's domains", () => {
      expect(resolveTenantCodeFromHost("ilovelawyer.com")).to.equal(null);
      expect(resolveTenantCodeFromHost("app.ilovelawyer.com")).to.equal(null);
      expect(resolveTenantCodeFromHost("localhost:3004")).to.equal(null);
    });
  });

  describe("emailed link origin", () => {
    const CLIENT = "https://ilovelawyer.com";
    const STAGING_CLIENT = "https://app.ilovelawyer.com";
    const PH_LAWYER = "http://ph.ilovelawyer.local:3002";
    let saved: { user: string[]; client: string[] };

    before(() => {
      saved = { user: [...USER_APP_URL], client: [...CLIENT_URL] };
      USER_APP_URL.splice(0, USER_APP_URL.length, CLIENT, STAGING_CLIENT);
      CLIENT_URL.splice(0, CLIENT_URL.length, PH_LAWYER, CLIENT, STAGING_CLIENT);
    });

    after(() => {
      USER_APP_URL.splice(0, USER_APP_URL.length, ...saved.user);
      CLIENT_URL.splice(0, CLIENT_URL.length, ...saved.client);
    });

    it("sends a client to the client app it asked from", () => {
      expect(emailLinkOriginForAccount({ role: "USER", tenant: { code: "UK" } }, STAGING_CLIENT)).to.equal(STAGING_CLIENT);
    });

    it("sends a client to the first client app when it asked from the lawyer app or no origin", () => {
      expect(emailLinkOriginForAccount({ role: "USER", tenant: { code: "UK" } }, PH_LAWYER)).to.equal(CLIENT);
      expect(emailLinkOriginForAccount({ role: "USER", tenant: { code: "UK" } }, null)).to.equal(CLIENT);
    });

    it("never sends a lawyer to the client app", () => {
      expect(emailLinkOriginForAccount({ role: "LAWYER", tenant: { code: "PH" } }, PH_LAWYER)).to.equal(PH_LAWYER);
      expect(emailLinkOriginForAccount({ role: "LAWYER", tenant: { code: "PH" } }, null)).to.equal(PH_LAWYER);
    });
  });

  describe("approval at email verification", () => {
    let restore: (() => void)[];
    let approved: string[];

    beforeEach(() => {
      approved = [];
      restore = [
        stash(AuthRepo, ["setApprovalStatus"]),
        stash(OrganizationEmailInviteRepo, ["claim"]),
        stash(TenantSettingSvc, ["isAutoApproveOn"]),
      ];
      (AuthRepo as any).setApprovalStatus = async (id: string) => void approved.push(id);
      (OrganizationEmailInviteRepo as any).claim = async () => false;
      (TenantSettingSvc as any).isAutoApproveOn = async () => false;
    });

    afterEach(() => restore.forEach((r) => r()));

    const pending = (role: "USER" | "LAWYER") => ({ id: `${role}-1`, email: "a@b.com", role, tenantId: null, approvalStatus: "PENDING" });

    it("activates a client account straight away", async () => {
      expect(await AuthSvc.autoApproveIfEnabled(pending("USER"))).to.equal(true);
      expect(approved).to.deep.equal(["USER-1"]);
    });

    it("leaves a lawyer PENDING for an admin when auto-approve is off", async () => {
      expect(await AuthSvc.autoApproveIfEnabled(pending("LAWYER"))).to.equal(false);
      expect(approved).to.be.empty;
    });
  });
});
