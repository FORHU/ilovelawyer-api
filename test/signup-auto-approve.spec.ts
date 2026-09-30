/** Per-Tenant "Auto-approve new signups" (admin Settings page): TenantSettingSvc's cached
 * switch, and AuthSvc applying it at the moment an email becomes verified — verifyOtp for
 * password signups, account creation for Google ones — rather than at row creation (see
 * AuthSvc.autoApproveIfEnabled for why).
 *
 * No live Postgres/Redis: repos, redis, mailer and template are monkeypatched on their
 * CommonJS module objects, same idiom as test/admin-session-revocation.spec.ts.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import AuthSvc from "../src/services/auth.service";
import TenantSettingSvc from "../src/services/tenant-setting.service";
import AuthRepo from "../src/repositories/auth.repository";
import TenantRepo from "../src/repositories/tenant.repository";
import TenantSettingRepo from "../src/repositories/tenant-setting.repository";
import OrganizationRepo from "../src/repositories/organization.repository";
import BulkApprovalRunner from "../src/queues/bulk-approval.runner";
import { redis } from "../src/lib/redis";
import * as mailerModule from "../src/utils/mailer";
import * as templateModule from "../src/utils/template";
import * as googleTokenModule from "../src/utils/googleToken";
import { updateTenantSettingsSchema } from "../src/validation/admin.validation";

const PH = "tenant-ph";
const UK = "tenant-uk";

type StubUser = {
  id: string;
  email: string;
  name: string | null;
  tenantId: string | null;
  approvalStatus: string;
  isEmailVerified: boolean;
  emailVerificationCode: string | null;
  emailVerificationExpiry: Date | null;
  emailVerificationAttempts: number;
};

function pendingUser(over: Partial<StubUser> = {}): StubUser {
  return {
    id: "user-1",
    email: "user@example.com",
    name: "Jane",
    tenantId: PH,
    approvalStatus: "PENDING",
    isEmailVerified: false,
    emailVerificationCode: "123456",
    emailVerificationExpiry: new Date(Date.now() + 60_000),
    emailVerificationAttempts: 0,
    ...over,
  };
}

function stash<T extends object>(target: T, keys: (keyof T)[]) {
  const saved = keys.map((k) => [k, target[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

describe("TenantSettingSvc.isAutoApproveOn", () => {
  let restore: (() => void)[];
  let repoReads: string[];
  let cache: Map<string, unknown>;

  beforeEach(() => {
    repoReads = [];
    cache = new Map();
    restore = [stash(TenantSettingRepo, ["find"]), stash(redis, ["get", "set"])];
    (TenantSettingRepo as any).find = async (tenantId: string) => {
      repoReads.push(tenantId);
      return tenantId === PH ? { tenantId, value: true, updatedAt: new Date(), updatedBy: null } : null;
    };
    (redis as any).get = async (key: string) => (cache.has(key) ? cache.get(key) : null);
    (redis as any).set = async (key: string, value: unknown) => void cache.set(key, value);
  });

  afterEach(() => restore.forEach((r) => r()));

  it("is off for a user with no Tenant, without reading anything", async () => {
    expect(await TenantSettingSvc.isAutoApproveOn(null)).to.equal(false);
    expect(repoReads).to.have.length(0);
  });

  it("is off for a Tenant with no setting row", async () => {
    expect(await TenantSettingSvc.isAutoApproveOn(UK)).to.equal(false);
  });

  it("reads the row once, then serves both true and false from the cache", async () => {
    expect(await TenantSettingSvc.isAutoApproveOn(PH)).to.equal(true);
    expect(await TenantSettingSvc.isAutoApproveOn(PH)).to.equal(true);
    expect(await TenantSettingSvc.isAutoApproveOn(UK)).to.equal(false);
    expect(await TenantSettingSvc.isAutoApproveOn(UK)).to.equal(false);
    expect(repoReads).to.deep.equal([PH, UK]);
  });
});

describe("AuthSvc — auto-approve at email verification", () => {
  let restore: (() => void)[];
  let onTenants: Set<string>;
  let current: StubUser;
  let statusChanges: { id: string; status: string }[];
  let sentTemplates: string[];

  beforeEach(() => {
    onTenants = new Set();
    current = pendingUser();
    statusChanges = [];
    sentTemplates = [];

    restore = [
      stash(TenantSettingSvc, ["isAutoApproveOn"]),
      stash(AuthRepo, [
        "findByEmail",
        "findByUsername",
        "findByGoogleId",
        "createUser",
        "createGoogleUser",
        "markEmailVerified",
        "setApprovalStatus",
        "updateLastLogin",
        "createSession",
        "findById",
      ]),
      stash(TenantRepo, ["findIdByCode"]),
      stash(mailerModule as any, ["sendEmail"]),
      stash(templateModule as any, ["renderTemplate"]),
      stash(googleTokenModule as any, ["default"]),
    ];

    (TenantSettingSvc as any).isAutoApproveOn = async (tenantId: string | null) => !!tenantId && onTenants.has(tenantId);
    (AuthRepo as any).findByEmail = async (email: string) => (email === current.email ? current : null);
    (AuthRepo as any).findByUsername = async () => null;
    (AuthRepo as any).findByGoogleId = async () => null;
    (AuthRepo as any).markEmailVerified = async () => {
      current = { ...current, isEmailVerified: true };
    };
    (AuthRepo as any).setApprovalStatus = async (id: string, status: string) => {
      statusChanges.push({ id, status });
      current = { ...current, approvalStatus: status };
      return current;
    };
    (AuthRepo as any).updateLastLogin = async () => {};
    (AuthRepo as any).createSession = async () => {};
    (AuthRepo as any).findById = async () => current;
    (TenantRepo as any).findIdByCode = async (code: string) => (code === "PH" ? PH : code === "UK" ? UK : null);
    (mailerModule as any).sendEmail = async () => {};
    (templateModule as any).renderTemplate = async (name: string) => {
      sentTemplates.push(name);
      return "<html></html>";
    };
  });

  afterEach(() => restore.forEach((r) => r()));

  describe("verifyOtp", () => {
    it("leaves the account PENDING when the Tenant's switch is off", async () => {
      const result = await AuthSvc.verifyOtp(current.email, "123456");
      expect(result.user).to.include({ approvalStatus: "PENDING" });
      expect(statusChanges).to.have.length(0);
    });

    it("returns the account ACTIVE when the Tenant's switch is on", async () => {
      onTenants.add(PH);
      const result = await AuthSvc.verifyOtp(current.email, "123456");
      expect(result.user).to.include({ approvalStatus: "ACTIVE" });
      expect(statusChanges).to.deep.equal([{ id: "user-1", status: "ACTIVE" }]);
    });

    it("keeps Tenants isolated — PH on doesn't approve a UK signup", async () => {
      onTenants.add(PH);
      current = pendingUser({ tenantId: UK });
      const result = await AuthSvc.verifyOtp(current.email, "123456");
      expect(result.user).to.include({ approvalStatus: "PENDING" });
    });

    it("never approves a signup with no Tenant", async () => {
      onTenants.add(PH).add(UK);
      current = pendingUser({ tenantId: null });
      const result = await AuthSvc.verifyOtp(current.email, "123456");
      expect(result.user).to.include({ approvalStatus: "PENDING" });
    });

    it("doesn't touch an account an admin already moved out of PENDING", async () => {
      onTenants.add(PH);
      current = pendingUser({ approvalStatus: "DENIED" });
      await AuthSvc.verifyOtp(current.email, "123456");
      expect(statusChanges).to.have.length(0);
    });
  });

  describe("signup", () => {
    beforeEach(() => {
      current = pendingUser({ email: "someone-else@example.com" });
      (AuthRepo as any).createUser = async (data: { email: string; name: string; tenantId: string | null }) =>
        pendingUser({ email: data.email, name: data.name, tenantId: data.tenantId });
    });

    it("sends the pending-approval email when the switch is off", async () => {
      await AuthSvc.signup("jane", "jane@example.com", "Password123!", "Jane", "PH");
      expect(sentTemplates).to.deep.equal(["signup-pending"]);
    });

    it("skips the pending-approval email when the switch is on, and leaves approval to verifyOtp", async () => {
      onTenants.add(PH);
      const user = await AuthSvc.signup("jane", "jane@example.com", "Password123!", "Jane", "PH");
      expect(sentTemplates).to.have.length(0);
      // Still PENDING at creation — cancelSignup must be able to clean it up until verified.
      expect(user.approvalStatus).to.equal("PENDING");
      expect(statusChanges).to.have.length(0);
    });
  });

  describe("loginWithGoogle (new account)", () => {
    beforeEach(() => {
      current = pendingUser({ email: "someone-else@example.com" });
      (googleTokenModule as any).default = async () => ({
        googleId: "g-1",
        email: "g@example.com",
        name: "Gee",
        isEmailVerified: true,
      });
      (AuthRepo as any).createGoogleUser = async ({ email, name, tenantId }: { email: string; name: string; tenantId: string | null }) => {
        current = pendingUser({ email, name, tenantId, isEmailVerified: true });
        return current;
      };
    });

    // acceptedTerms: true — a brand-new Google account can't be created without it (see
    // test/auth-google.spec.ts for the TERMS_ACCEPTANCE_REQUIRED path).
    it("creates the account PENDING and sends the pending email when the switch is off", async () => {
      const result = await AuthSvc.loginWithGoogle("token", true, "PH", true);
      expect(result.user).to.include({ approvalStatus: "PENDING" });
      expect(sentTemplates).to.deep.equal(["signup-pending"]);
    });

    it("returns the account ACTIVE with no pending email when the switch is on", async () => {
      onTenants.add(PH);
      const result = await AuthSvc.loginWithGoogle("token", true, "PH", true);
      expect(result.user).to.include({ approvalStatus: "ACTIVE" });
      expect(sentTemplates).to.have.length(0);
    });
  });
});

describe("TenantSettingSvc.setAutoApprove", () => {
  let restore: (() => void)[];
  let upserts: { tenantId: string; key: string; value: unknown; updatedById: string }[];
  let deletedKeys: string[];
  let audits: { actorId?: string; action: string; payload?: object }[];

  beforeEach(() => {
    upserts = [];
    deletedKeys = [];
    audits = [];
    restore = [
      stash(TenantRepo, ["findByCode", "listAll"]),
      stash(TenantSettingRepo, ["find", "findAllForKey", "upsert"]),
      stash(AuthRepo, ["countApprovablePending"]),
      stash(BulkApprovalRunner, ["getProgress"]),
      stash(OrganizationRepo, ["writeAudit"]),
      stash(redis, ["del"]),
    ];

    (TenantRepo as any).findByCode = async (code: string) => (code === "PH" ? { id: PH, code: "PH", name: "Philippines" } : null);
    (TenantRepo as any).listAll = async () => [
      { id: PH, code: "PH", name: "Philippines" },
      { id: UK, code: "UK", name: "United Kingdom" },
    ];
    (TenantSettingRepo as any).find = async () => null;
    (TenantSettingRepo as any).findAllForKey = async () =>
      upserts.map((u) => ({ tenantId: u.tenantId, value: u.value, updatedAt: new Date(), updatedBy: { name: "Admin", email: "a@x" } }));
    (TenantSettingRepo as any).upsert = async (tenantId: string, key: string, value: unknown, updatedById: string) => {
      upserts.push({ tenantId, key, value, updatedById });
    };
    (AuthRepo as any).countApprovablePending = async () => 3;
    (BulkApprovalRunner as any).getProgress = async () => null;
    (OrganizationRepo as any).writeAudit = async (data: any) => void audits.push(data);
    (redis as any).del = async (key: string) => void deletedKeys.push(key);
  });

  afterEach(() => restore.forEach((r) => r()));

  it("saves the switch, clears that Tenant's cache, audits the change and returns the Tenant's entry", async () => {
    const entry = await TenantSettingSvc.setAutoApprove("PH", true, "admin-1");

    expect(upserts).to.deep.equal([{ tenantId: PH, key: "signup.autoApprove", value: true, updatedById: "admin-1" }]);
    expect(deletedKeys).to.deep.equal([`tenant-settings:${PH}:signup.autoApprove`]);
    expect(audits).to.deep.equal([
      { actorId: "admin-1", action: "settings.signup_auto_approve.changed", payload: { tenant: "PH", from: false, to: true } },
    ]);
    expect(entry).to.include({ code: "PH", autoApproveSignups: true, pendingCount: 3 });
  });

  it("404s for a Tenant that isn't seeded", async () => {
    let threw: any;
    try {
      await TenantSettingSvc.setAutoApprove("UK", true, "admin-1");
    } catch (e) {
      threw = e;
    }
    expect(threw?.statusCode).to.equal(404);
    expect(upserts).to.have.length(0);
  });
});

describe("updateTenantSettingsSchema", () => {
  it("accepts a real boolean", () => {
    expect(updateTenantSettingsSchema.validate({ autoApproveSignups: false }).error).to.equal(undefined);
  });

  it("rejects strings and numbers instead of coercing them", () => {
    expect(updateTenantSettingsSchema.validate({ autoApproveSignups: "true" }).error).to.exist;
    expect(updateTenantSettingsSchema.validate({ autoApproveSignups: 1 }).error).to.exist;
    expect(updateTenantSettingsSchema.validate({}).error).to.exist;
  });
});
