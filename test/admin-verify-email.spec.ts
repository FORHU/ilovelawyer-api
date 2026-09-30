/** AdminSvc.verifyEmail — POST /api/admin/users/:id/verify-email. An admin marks a user's email
 * verified in place of the signup OTP; a PENDING user on an auto-approve Tenant is approved at
 * that moment, the same as AuthSvc.verifyOtp does.
 *
 * No live Postgres/Redis: repos and redis are monkeypatched on their CommonJS module objects,
 * same idiom as test/admin-change-tenant.spec.ts.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import AdminSvc from "../src/services/admin.service";
import TenantSettingSvc from "../src/services/tenant-setting.service";
import AuthRepo from "../src/repositories/auth.repository";
import OrganizationRepo from "../src/repositories/organization.repository";
import { redis } from "../src/lib/redis";

function stash<T extends object>(target: T, keys: (keyof T)[]) {
  const saved = keys.map((k) => [k, target[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

type StubUser = { id: string; tenantId: string | null; isEmailVerified: boolean; approvalStatus: string };

describe("AdminSvc.verifyEmail", () => {
  let restore: (() => void)[];
  let current: StubUser | null;
  let autoApproveOn: boolean;
  let verifiedIds: string[];
  let approvals: { userId: string; status: string }[];
  let audits: { actorId?: string; action: string; payload?: object }[];
  let cacheBusts: number;

  beforeEach(() => {
    current = { id: "user-1", tenantId: "tenant-uk", isEmailVerified: false, approvalStatus: "ACTIVE" };
    autoApproveOn = false;
    verifiedIds = [];
    approvals = [];
    audits = [];
    cacheBusts = 0;

    restore = [
      stash(AuthRepo, ["findById", "markEmailVerified", "setApprovalStatus"]),
      stash(TenantSettingSvc, ["isAutoApproveOn"]),
      stash(OrganizationRepo, ["writeAudit"]),
      stash(redis, ["incr"]),
    ];

    (AuthRepo as any).findById = async (id: string) => (current && id === current.id ? { ...current } : null);
    (AuthRepo as any).markEmailVerified = async (id: string) => {
      verifiedIds.push(id);
      current!.isEmailVerified = true;
      return { ...current! };
    };
    (AuthRepo as any).setApprovalStatus = async (userId: string, status: string) => {
      approvals.push({ userId, status });
      current!.approvalStatus = status;
      return { ...current! };
    };
    (TenantSettingSvc as any).isAutoApproveOn = async () => autoApproveOn;
    (OrganizationRepo as any).writeAudit = async (data: any) => void audits.push(data);
    (redis as any).incr = async () => ++cacheBusts;
  });

  afterEach(() => restore.forEach((r) => r()));

  it("marks an unverified user verified, clears the users-list cache and audits it", async () => {
    const result = await AdminSvc.verifyEmail("user-1", "admin-1");

    expect(result?.isEmailVerified).to.equal(true);
    expect(verifiedIds).to.deep.equal(["user-1"]);
    expect(approvals).to.have.length(0);
    expect(cacheBusts).to.equal(1);
    expect(audits).to.deep.equal([
      { actorId: "admin-1", action: "users.email_verified", payload: { userId: "user-1", autoApproved: false } },
    ]);
  });

  it("auto-approves a PENDING user when their Tenant has auto-approve on", async () => {
    current!.approvalStatus = "PENDING";
    autoApproveOn = true;

    const result = await AdminSvc.verifyEmail("user-1", "admin-1");

    expect(approvals).to.deep.equal([{ userId: "user-1", status: "ACTIVE" }]);
    expect(result?.approvalStatus).to.equal("ACTIVE");
    expect(audits[0].payload).to.deep.equal({ userId: "user-1", autoApproved: true });
  });

  it("leaves a PENDING user pending when their Tenant has auto-approve off", async () => {
    current!.approvalStatus = "PENDING";

    const result = await AdminSvc.verifyEmail("user-1", "admin-1");

    expect(approvals).to.have.length(0);
    expect(result?.approvalStatus).to.equal("PENDING");
  });

  it("refuses an already-verified user (409), without writing", async () => {
    current!.isEmailVerified = true;
    let threw: any;
    try {
      await AdminSvc.verifyEmail("user-1", "admin-1");
    } catch (e) {
      threw = e;
    }
    expect(threw?.statusCode).to.equal(409);
    expect(verifiedIds).to.have.length(0);
    expect(audits).to.have.length(0);
    expect(cacheBusts).to.equal(0);
  });

  it("404s for an unknown user", async () => {
    current = null;
    let threw: any;
    try {
      await AdminSvc.verifyEmail("missing", "admin-1");
    } catch (e) {
      threw = e;
    }
    expect(threw?.statusCode).to.equal(404);
  });
});
