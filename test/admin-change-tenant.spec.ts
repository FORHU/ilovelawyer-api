/** AdminSvc.changeTenant — PATCH /api/admin/users/:id/tenant. Moves a user between Tenants
 * (which decides whose auto-approve switch / bulk approval applies to them), but never away
 * from their Organization's Tenant, which is what sign-in access actually checks.
 *
 * No live Postgres/Redis: repos and redis are monkeypatched on their CommonJS module objects,
 * same idiom as test/admin-session-revocation.spec.ts.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import AdminSvc from "../src/services/admin.service";
import AuthRepo from "../src/repositories/auth.repository";
import TenantRepo from "../src/repositories/tenant.repository";
import OrganizationRepo from "../src/repositories/organization.repository";
import OrganizationMemberRepo from "../src/repositories/organization-member.repository";
import { redis } from "../src/lib/redis";
import { updateUserTenantSchema } from "../src/validation/admin.validation";

function stash<T extends object>(target: T, keys: (keyof T)[]) {
  const saved = keys.map((k) => [k, target[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

const TENANT_IDS: Record<string, string> = { PH: "tenant-ph", UK: "tenant-uk" };

describe("AdminSvc.changeTenant", () => {
  let restore: (() => void)[];
  let current: { id: string; tenantId: string | null; tenant: { code: string } | null } | null;
  let orgTenant: string | null;
  let writes: { userId: string; tenantId: string }[];
  let audits: { actorId?: string; action: string; payload?: object }[];
  let cacheBusts: number;

  beforeEach(() => {
    current = { id: "user-1", tenantId: null, tenant: null };
    orgTenant = null;
    writes = [];
    audits = [];
    cacheBusts = 0;

    restore = [
      stash(AuthRepo, ["findTenantById", "setTenant"]),
      stash(TenantRepo, ["findIdByCode"]),
      stash(OrganizationMemberRepo, ["findAnyForUser"]),
      stash(OrganizationRepo, ["writeAudit"]),
      stash(redis, ["incr"]),
    ];

    (AuthRepo as any).findTenantById = async (id: string) => (current && id === current.id ? current : null);
    (AuthRepo as any).setTenant = async (userId: string, tenantId: string) => {
      writes.push({ userId, tenantId });
      const code = Object.keys(TENANT_IDS).find((c) => TENANT_IDS[c] === tenantId)!;
      return { id: userId, tenant: { code, name: code } };
    };
    (TenantRepo as any).findIdByCode = async (code: string) => TENANT_IDS[code] ?? null;
    (OrganizationMemberRepo as any).findAnyForUser = async () =>
      orgTenant ? { organization: { tenant: { code: orgTenant } } } : null;
    (OrganizationRepo as any).writeAudit = async (data: any) => void audits.push(data);
    (redis as any).incr = async () => ++cacheBusts;
  });

  afterEach(() => restore.forEach((r) => r()));

  it("sets a tenant-less user's tenant, clears the users-list cache and audits the change", async () => {
    const result = await AdminSvc.changeTenant("user-1", "UK", "admin-1");

    expect(result).to.deep.equal({ id: "user-1", tenant: { code: "UK", name: "UK" } });
    expect(writes).to.deep.equal([{ userId: "user-1", tenantId: "tenant-uk" }]);
    expect(cacheBusts).to.equal(1);
    expect(audits).to.deep.equal([
      { actorId: "admin-1", action: "users.tenant_changed", payload: { userId: "user-1", from: null, to: "UK" } },
    ]);
  });

  it("moves a user between tenants when they have no organization", async () => {
    current = { id: "user-1", tenantId: "tenant-ph", tenant: { code: "PH" } };
    await AdminSvc.changeTenant("user-1", "UK", "admin-1");
    expect(audits[0].payload).to.deep.equal({ userId: "user-1", from: "PH", to: "UK" });
  });

  it("allows setting the tenant their organization is already in", async () => {
    orgTenant = "PH";
    await AdminSvc.changeTenant("user-1", "PH", "admin-1");
    expect(writes).to.have.length(1);
  });

  it("refuses a tenant that contradicts the user's organization (409), without writing", async () => {
    orgTenant = "PH";
    let threw: any;
    try {
      await AdminSvc.changeTenant("user-1", "UK", "admin-1");
    } catch (e) {
      threw = e;
    }
    expect(threw?.statusCode).to.equal(409);
    expect(writes).to.have.length(0);
    expect(audits).to.have.length(0);
  });

  it("is a no-op for the audit log when the user is already in that tenant", async () => {
    current = { id: "user-1", tenantId: "tenant-uk", tenant: { code: "UK" } };
    await AdminSvc.changeTenant("user-1", "UK", "admin-1");
    expect(audits).to.have.length(0);
    expect(cacheBusts).to.equal(0);
  });

  it("404s for an unknown user", async () => {
    current = null;
    let threw: any;
    try {
      await AdminSvc.changeTenant("missing", "PH", "admin-1");
    } catch (e) {
      threw = e;
    }
    expect(threw?.statusCode).to.equal(404);
  });
});

describe("updateUserTenantSchema", () => {
  it("accepts PH and UK only", () => {
    expect(updateUserTenantSchema.validate({ tenantCode: "PH" }).error).to.equal(undefined);
    expect(updateUserTenantSchema.validate({ tenantCode: "UK" }).error).to.equal(undefined);
    expect(updateUserTenantSchema.validate({ tenantCode: "US" }).error).to.exist;
    expect(updateUserTenantSchema.validate({ tenantCode: null }).error).to.exist;
    expect(updateUserTenantSchema.validate({}).error).to.exist;
  });
});
