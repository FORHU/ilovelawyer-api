/** ilovelawyer-app (LAWYER) and the client app (USER) share this API: the X-Client-App header
 * picks a new account's role, an account signs in only to its own app (ADMIN to either), and a
 * client account is active as soon as its email is verified, while a lawyer still waits for
 * admin approval. See src/utils/client-app.ts.
 *
 * No live Postgres: repositories are monkeypatched on their CommonJS module objects, same idiom
 * as test/account-restore-on-login.spec.ts.
 */
import { expect } from "chai";
import { describe, it, before, beforeEach, afterEach } from "mocha";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import type { Request } from "express";
import AuthSvc from "../src/services/auth.service";
import AuthRepo from "../src/repositories/auth.repository";
import OrganizationEmailInviteRepo from "../src/repositories/organization-email-invite.repository";
import TenantSettingSvc from "../src/services/tenant-setting.service";
import { runWithRequestContext } from "../src/lib/request-context";
import { ClientApp, resolveClientApp } from "../src/utils/client-app";
import * as mailerModule from "../src/utils/mailer";
import * as templateModule from "../src/utils/template";
import { REFRESH_TOKEN_SECRET } from "../src/config";

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

    beforeEach(() => {
      created = [];
      emails = [];
      restore = [
        stash(AuthRepo, ["findByEmail", "findByUsername", "createUser"]),
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
      (TenantSettingSvc as any).isAutoApproveOn = async () => false;
      (OrganizationEmailInviteRepo as any).hasLiveInvite = async () => false;
      (templateModule as any).renderTemplate = async (name: string) => name;
      (mailerModule as any).sendEmail = async (mail: { html: string }) => void emails.push(mail.html);
    });

    afterEach(() => restore.forEach((r) => r()));

    const signup = () => AuthSvc.signup("a", "a@b.com", "Password123!", "A");

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
