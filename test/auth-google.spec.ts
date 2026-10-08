/** AuthSvc.loginWithGoogle / linkGoogle — Terms acceptance, email normalization, creation
 * races (Prisma P2002 on googleId/email/username), account linking and Remember Me.
 *
 * No live Postgres/Google: AuthRepo, TenantRepo, OrganizationMemberRepo, verifyGoogleToken,
 * mailer's sendEmail and template's renderTemplate are monkeypatched on their CommonJS module
 * objects, same idiom as test/admin-session-revocation.spec.ts.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { Prisma } from "@prisma/client";
import AuthSvc from "../src/services/auth.service";
import AuthRepo from "../src/repositories/auth.repository";
import TenantRepo from "../src/repositories/tenant.repository";
import OrganizationMemberRepo from "../src/repositories/organization-member.repository";
import OrganizationEmailInviteRepo from "../src/repositories/organization-email-invite.repository";
import * as googleTokenModule from "../src/utils/googleToken";
import * as mailerModule from "../src/utils/mailer";
import * as templateModule from "../src/utils/template";
import HttpError from "../src/utils/http-error";
import { isUniqueViolation, normalizeEmail } from "../src/utils/auth.utils";
import { REFRESH_TOKEN_SECRET } from "../src/config";
import { GOOGLE_PHOTO_SIGNUP_WAIT_MS, TERMS_VERSION } from "../src/constants";
import AvatarSvc from "../src/services/avatar.service";
import prisma from "../src/lib/prisma";

// Captured before any test monkeypatches AuthRepo.createGoogleUser.
const realCreateGoogleUser = AuthRepo.createGoogleUser.bind(AuthRepo);

type Row = {
  id: string;
  email: string;
  password: string | null;
  name: string | null;
  role: string;
  googleId: string | null;
  isEmailVerified: boolean;
  approvalStatus: string;
  mustChangePassword: boolean;
  tenant: { code: string; name: string } | null;
};

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: "user-1",
    email: "jane@firm.com",
    password: null,
    name: "Jane",
    role: "USER",
    googleId: null,
    isEmailVerified: true,
    approvalStatus: "ACTIVE",
    mustChangePassword: false,
    tenant: null,
    ...overrides,
  };
}

function p2002(field: string) {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "5",
    meta: { target: [field] },
  });
}

async function expectHttpError(promise: Promise<unknown>, status: number, code?: string) {
  try {
    await promise;
  } catch (err) {
    expect(err).to.be.instanceOf(HttpError);
    expect((err as HttpError).statusCode).to.equal(status);
    if (code !== undefined) expect((err as HttpError).code).to.equal(code);
    return err as HttpError;
  }
  throw new Error(`expected HttpError ${status}`);
}

const repoKeys = [
  "findByGoogleId",
  "findByEmail",
  "createGoogleUser",
  "deleteUnverifiedPendingUser",
  "linkGoogleId",
  "createSession",
  "updateLastLogin",
  "findById",
] as const;

describe("AuthSvc Google sign-in", () => {
  const originals = {
    repo: Object.fromEntries(repoKeys.map((k) => [k, (AuthRepo as any)[k]])),
    findIdByCode: (TenantRepo as any).findIdByCode,
    findAnyForUser: (OrganizationMemberRepo as any).findAnyForUser,
    claimEmailInvite: (OrganizationEmailInviteRepo as any).claim,
    verifyGoogleToken: (googleTokenModule as any).default,
    sendEmail: (mailerModule as any).sendEmail,
    renderTemplate: (templateModule as any).renderTemplate,
  };

  let google: { googleId: string; email: string; name?: string; picture?: string; isEmailVerified: boolean };
  let createdGoogleUsers: any[];
  let deletedPending: string[];
  let sessions: { userId: string; refreshToken: string }[];
  let sentEmails: string[];

  beforeEach(() => {
    google = { googleId: "sub-1", email: "Jane@Firm.com", name: "Jane", isEmailVerified: true };
    createdGoogleUsers = [];
    deletedPending = [];
    sessions = [];
    sentEmails = [];

    (googleTokenModule as any).default = async () => google;
    (AuthRepo as any).findByGoogleId = async () => null;
    (AuthRepo as any).findByEmail = async () => null;
    (AuthRepo as any).createGoogleUser = async (data: any) => {
      createdGoogleUsers.push(data);
      return row({ id: "new-user", email: data.email, googleId: data.googleId, approvalStatus: "PENDING" });
    };
    (AuthRepo as any).deleteUnverifiedPendingUser = async (email: string) => {
      deletedPending.push(email);
    };
    (AuthRepo as any).linkGoogleId = async () => true;
    (AuthRepo as any).createSession = async (userId: string, refreshToken: string) => {
      sessions.push({ userId, refreshToken });
    };
    (AuthRepo as any).updateLastLogin = async () => {};
    (AuthRepo as any).findById = async (id: string) => ({ id });
    (TenantRepo as any).findIdByCode = async () => null;
    (OrganizationMemberRepo as any).findAnyForUser = async () => null;
    (OrganizationEmailInviteRepo as any).claim = async () => false;
    (templateModule as any).renderTemplate = async (name: string) => name;
    (mailerModule as any).sendEmail = async ({ html }: { html: string }) => {
      sentEmails.push(html);
    };
  });

  afterEach(() => {
    for (const k of repoKeys) (AuthRepo as any)[k] = originals.repo[k];
    (TenantRepo as any).findIdByCode = originals.findIdByCode;
    (OrganizationMemberRepo as any).findAnyForUser = originals.findAnyForUser;
    (OrganizationEmailInviteRepo as any).claim = originals.claimEmailInvite;
    (googleTokenModule as any).default = originals.verifyGoogleToken;
    (mailerModule as any).sendEmail = originals.sendEmail;
    (templateModule as any).renderTemplate = originals.renderTemplate;
  });

  describe("loginWithGoogle", () => {
    it("creates a new user with a lowercased email and Terms recorded, and sends one pending email", async () => {
      const result = await AuthSvc.loginWithGoogle("token", true, null, true);

      expect(createdGoogleUsers).to.have.length(1);
      expect(createdGoogleUsers[0]).to.include({ email: "jane@firm.com", googleId: "sub-1", termsVersion: TERMS_VERSION });
      expect(sentEmails).to.deep.equal(["signup-pending"]);
      expect(sessions).to.have.length(1);
      expect(result.user).to.deep.equal({ id: "new-user" });
    });

    it("waits for a quick Google photo copy so the response already carries the avatar", async () => {
      const realImport = (AvatarSvc as any).importGooglePhoto;
      const order: string[] = [];
      (AvatarSvc as any).importGooglePhoto = async (_userId: string, picture: string) => {
        await new Promise((r) => setTimeout(r, 20));
        order.push(`imported ${picture}`);
      };
      (AuthRepo as any).findById = async (id: string) => {
        order.push("read user");
        return { id };
      };
      try {
        google.picture = "https://lh3.googleusercontent.com/a/x";
        await AuthSvc.loginWithGoogle("token", true, null, true);
        expect(order).to.deep.equal(["imported https://lh3.googleusercontent.com/a/x", "read user"]);
      } finally {
        (AvatarSvc as any).importGooglePhoto = realImport;
      }
    });

    it("doesn't let a slow Google photo copy hold sign-in past the wait limit", async function () {
      this.timeout(GOOGLE_PHOTO_SIGNUP_WAIT_MS + 2000);
      const realImport = (AvatarSvc as any).importGooglePhoto;
      (AvatarSvc as any).importGooglePhoto = () => new Promise(() => {});
      try {
        const started = Date.now();
        const result = await AuthSvc.loginWithGoogle("token", true, null, true);
        expect(Date.now() - started).to.be.lessThan(GOOGLE_PHOTO_SIGNUP_WAIT_MS + 1000);
        expect(sessions).to.have.length(1);
        expect(result.user).to.deep.equal({ id: "new-user" });
      } finally {
        (AvatarSvc as any).importGooglePhoto = realImport;
      }
    });

    it("refuses to create an account without Terms acceptance (428) and creates nothing", async () => {
      await expectHttpError(AuthSvc.loginWithGoogle("token", true, null, false), 428, "TERMS_ACCEPTANCE_REQUIRED");
      expect(createdGoogleUsers).to.be.empty;
      expect(sentEmails).to.be.empty;
      expect(sessions).to.be.empty;
    });

    it("never asks a returning Google user for Terms", async () => {
      (AuthRepo as any).findByGoogleId = async () => row({ googleId: "sub-1" });

      await AuthSvc.loginWithGoogle("token", true, null, false);

      expect(createdGoogleUsers).to.be.empty;
      expect(sentEmails).to.be.empty;
      expect(sessions).to.have.length(1);
    });

    it("rejects an unverified Google email", async () => {
      google.isEmailVerified = false;
      await expectHttpError(AuthSvc.loginWithGoogle("token", true, null, true), 401);
      expect(createdGoogleUsers).to.be.empty;
    });

    it("looks up the existing account by the normalized email", async () => {
      let lookedUp: string | undefined;
      (AuthRepo as any).findByEmail = async (email: string) => {
        lookedUp = email;
        return null;
      };

      await AuthSvc.loginWithGoogle("token", true, null, true);

      expect(lookedUp).to.equal("jane@firm.com");
    });

    it("answers GOOGLE_LINK_REQUIRED (with the account's email) for a verified password account", async () => {
      (AuthRepo as any).findByEmail = async () => row({ password: "hash" });

      const err = await expectHttpError(AuthSvc.loginWithGoogle("token", true, null, true), 409, "GOOGLE_LINK_REQUIRED");

      expect(err.details).to.deep.equal({ email: "jane@firm.com" });
      expect(createdGoogleUsers).to.be.empty;
    });

    it("answers GOOGLE_ACCOUNT_MISMATCH when the email is bound to another Google identity", async () => {
      (AuthRepo as any).findByEmail = async () => row({ googleId: "sub-other" });
      await expectHttpError(AuthSvc.loginWithGoogle("token", true, null, true), 409, "GOOGLE_ACCOUNT_MISMATCH");
    });

    it("offers no link to an ADMIN account or one on another Tenant", async () => {
      (AuthRepo as any).findByEmail = async () => row({ role: "ADMIN" });
      const adminErr = await expectHttpError(AuthSvc.loginWithGoogle("token", true, null, true), 409);
      expect(adminErr.code).to.equal(undefined);

      (AuthRepo as any).findByEmail = async () => row({ tenant: { code: "UK", name: "United Kingdom" } });
      const tenantErr = await expectHttpError(AuthSvc.loginWithGoogle("token", true, "PH" as any, true), 409);
      expect(tenantErr.code).to.equal(undefined);
    });

    it("replaces an abandoned unverified PENDING password signup instead of blocking the Google owner", async () => {
      (AuthRepo as any).findByEmail = async () => row({ isEmailVerified: false, approvalStatus: "PENDING", password: "hash" });

      await AuthSvc.loginWithGoogle("token", true, null, true);

      expect(deletedPending).to.deep.equal(["jane@firm.com"]);
      expect(createdGoogleUsers).to.have.length(1);
    });

    it("still requires Terms before replacing an abandoned signup", async () => {
      (AuthRepo as any).findByEmail = async () => row({ isEmailVerified: false, approvalStatus: "PENDING" });

      await expectHttpError(AuthSvc.loginWithGoogle("token", true, null, false), 428, "TERMS_ACCEPTANCE_REQUIRED");

      expect(deletedPending).to.be.empty;
    });

    it("resolves a lost googleId race to the winner's account instead of a 500", async () => {
      let lookups = 0;
      (AuthRepo as any).findByGoogleId = async () => (lookups++ === 0 ? null : row({ id: "winner", googleId: "sub-1" }));
      (AuthRepo as any).createGoogleUser = async () => {
        throw p2002("googleId");
      };

      const result = await AuthSvc.loginWithGoogle("token", true, null, true);

      expect(result.user).to.deep.equal({ id: "winner" });
      expect(sessions.map((s) => s.userId)).to.deep.equal(["winner"]);
      expect(sentEmails).to.be.empty;
    });

    it("resolves an email race won by the same identity, and reports a different one as a conflict", async () => {
      let emailLookups = 0;
      (AuthRepo as any).findByEmail = async () => (emailLookups++ === 0 ? null : row({ id: "winner", googleId: "sub-1" }));
      (AuthRepo as any).createGoogleUser = async () => {
        throw p2002("email");
      };

      const result = await AuthSvc.loginWithGoogle("token", true, null, true);
      expect(result.user).to.deep.equal({ id: "winner" });

      emailLookups = 0;
      (AuthRepo as any).findByEmail = async () => (emailLookups++ === 0 ? null : row({ id: "someone-else", password: "hash" }));
      await expectHttpError(AuthSvc.loginWithGoogle("token", true, null, true), 409, "GOOGLE_LINK_REQUIRED");
    });

    it("rethrows a create failure it can't attribute to a race", async () => {
      const boom = new Error("db down");
      (AuthRepo as any).createGoogleUser = async () => {
        throw boom;
      };

      try {
        await AuthSvc.loginWithGoogle("token", true, null, true);
        throw new Error("expected rejection");
      } catch (err) {
        expect(err).to.equal(boom);
      }
    });

    it("still signs the user in when the pending-approval email fails", async () => {
      (mailerModule as any).sendEmail = async () => {
        throw new Error("smtp down");
      };

      const result = await AuthSvc.loginWithGoogle("token", true, null, true);

      expect(result.accessToken).to.be.a("string").that.is.not.empty;
      expect(sessions).to.have.length(1);
    });

    it("embeds the Remember Me choice in the refresh token", async () => {
      (AuthRepo as any).findByGoogleId = async () => row({ googleId: "sub-1" });

      const off = await AuthSvc.loginWithGoogle("token", false, null, false);
      const on = await AuthSvc.loginWithGoogle("token", true, null, false);

      expect((jwt.verify(off.refreshToken, REFRESH_TOKEN_SECRET) as any).remember).to.equal(false);
      expect((jwt.verify(on.refreshToken, REFRESH_TOKEN_SECRET) as any).remember).to.equal(true);
    });
  });

  describe("linkGoogle", () => {
    let passwordHash: string;

    beforeEach(async () => {
      passwordHash = await bcrypt.hash("Correct-Horse-1", 4);
      (AuthRepo as any).findByEmail = async () => row({ password: passwordHash });
    });

    it("links a verified Google identity after the account password is confirmed", async () => {
      let linked: [string, string] | undefined;
      (AuthRepo as any).linkGoogleId = async (userId: string, googleId: string) => {
        linked = [userId, googleId];
        return true;
      };

      const result = await AuthSvc.linkGoogle("token", "Correct-Horse-1", false, null);

      expect(linked).to.deep.equal(["user-1", "sub-1"]);
      expect(sentEmails).to.deep.equal(["google-connected"]);
      expect((jwt.verify(result.refreshToken, REFRESH_TOKEN_SECRET) as any).remember).to.equal(false);
    });

    it("rejects a wrong password without linking", async () => {
      let linkCalled = false;
      (AuthRepo as any).linkGoogleId = async () => {
        linkCalled = true;
        return true;
      };

      await expectHttpError(AuthSvc.linkGoogle("token", "wrong", true, null), 401);

      expect(linkCalled).to.equal(false);
      expect(sessions).to.be.empty;
    });

    it("keeps the forced password update gate (428) and doesn't link", async () => {
      (AuthRepo as any).findByEmail = async () => row({ password: passwordHash, mustChangePassword: true });
      await expectHttpError(AuthSvc.linkGoogle("token", "Correct-Horse-1", true, null), 428);
    });

    it("refuses an unverified local account and an ADMIN account", async () => {
      (AuthRepo as any).findByEmail = async () => row({ password: passwordHash, isEmailVerified: false });
      await expectHttpError(AuthSvc.linkGoogle("token", "Correct-Horse-1", true, null), 403);

      (AuthRepo as any).findByEmail = async () => row({ password: passwordHash, role: "ADMIN" });
      await expectHttpError(AuthSvc.linkGoogle("token", "Correct-Horse-1", true, null), 409);
    });

    it("reports a link that lost a race (or a googleId owned elsewhere) as a mismatch", async () => {
      (AuthRepo as any).linkGoogleId = async () => false;
      await expectHttpError(AuthSvc.linkGoogle("token", "Correct-Horse-1", true, null), 409, "GOOGLE_ACCOUNT_MISMATCH");
      expect(sessions).to.be.empty;
    });

    it("is idempotent for an account already linked to this identity", async () => {
      let linkCalled = false;
      (AuthRepo as any).findByEmail = async () => row({ password: passwordHash, googleId: "sub-1" });
      (AuthRepo as any).linkGoogleId = async () => {
        linkCalled = true;
        return true;
      };

      await AuthSvc.linkGoogle("token", "Correct-Horse-1", true, null);

      expect(linkCalled).to.equal(false);
      expect(sentEmails).to.be.empty;
      expect(sessions).to.have.length(1);
    });
  });
});

describe("AuthRepo.createGoogleUser", () => {
  const originalCreate = (prisma.user as any).create;
  afterEach(() => {
    (prisma.user as any).create = originalCreate;
  });

  it("retries a username collision with a new suffix and stores the normalized email", async () => {
    const attempts: any[] = [];
    (prisma.user as any).create = async ({ data }: any) => {
      attempts.push(data);
      if (attempts.length < 3) throw p2002("username");
      return data;
    };

    const created = await realCreateGoogleUser({ email: " John@Firm.com", googleId: "sub-1", termsVersion: TERMS_VERSION });

    expect(attempts).to.have.length(3);
    expect(attempts[0].username).to.equal("john");
    expect(attempts[2].username).to.match(/^john\d{4}$/);
    expect(created).to.include({ email: "john@firm.com", termsVersion: TERMS_VERSION });
  });

  it("rethrows a googleId/email collision for the service to resolve", async () => {
    (prisma.user as any).create = async () => {
      throw p2002("googleId");
    };
    try {
      await realCreateGoogleUser({ email: "john@firm.com", googleId: "sub-1", termsVersion: TERMS_VERSION });
      throw new Error("expected rejection");
    } catch (err) {
      expect(isUniqueViolation(err, "googleId")).to.equal(true);
    }
  });
});

describe("auth utils", () => {
  it("normalizeEmail trims and lowercases only", () => {
    expect(normalizeEmail("  John.Doe+Tag@Firm.COM ")).to.equal("john.doe+tag@firm.com");
  });

  it("isUniqueViolation matches P2002 by field, as an array or a constraint name", () => {
    expect(isUniqueViolation(p2002("username"), "username")).to.equal(true);
    expect(isUniqueViolation(p2002("username"), "email")).to.equal(false);
    const named = new Prisma.PrismaClientKnownRequestError("x", { code: "P2002", clientVersion: "5", meta: { target: "User_email_key" } });
    expect(isUniqueViolation(named, "email")).to.equal(true);
    expect(isUniqueViolation(new Error("nope"), "email")).to.equal(false);
  });
});
