/** AdminSvc.deleteUser — DELETE /api/admin/users/:id. An admin hard-deletes a user immediately,
 * whatever their approvalStatus: no grace period, no email, through the same
 * AccountDeletionSvc.purge that AccountDeletionQueue uses.
 *
 * No live Postgres/Redis: repos and services are monkeypatched on their CommonJS module objects,
 * same idiom as test/admin-verify-email.spec.ts.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import AdminSvc from "../src/services/admin.service";
import AccountDeletionSvc from "../src/services/account-deletion.service";
import AuthRepo from "../src/repositories/auth.repository";
import OrganizationRepo from "../src/repositories/organization.repository";

function stash<T extends object>(target: T, keys: (keyof T)[]) {
  const saved = keys.map((k) => [k, target[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

type StubUser = { id: string; email: string; role: string; approvalStatus: string };

async function statusOf(promise: Promise<unknown>): Promise<number | undefined> {
  try {
    await promise;
  } catch (e) {
    return (e as any)?.statusCode;
  }
  return undefined;
}

describe("AdminSvc.deleteUser", () => {
  let restore: (() => void)[];
  let current: StubUser | null;
  let purged: string[];
  let audits: { actorId?: string; action: string; payload?: object }[];

  beforeEach(() => {
    current = { id: "user-1", email: "user@example.com", role: "USER", approvalStatus: "ACTIVE" };
    purged = [];
    audits = [];

    restore = [
      stash(AuthRepo, ["findById"]),
      stash(AccountDeletionSvc, ["purge"]),
      stash(OrganizationRepo, ["writeAudit"]),
    ];

    (AuthRepo as any).findById = async (id: string) => (current && id === current.id ? { ...current } : null);
    (AccountDeletionSvc as any).purge = async (id: string) => void purged.push(id);
    (OrganizationRepo as any).writeAudit = async (data: any) => void audits.push(data);
  });

  afterEach(() => restore.forEach((r) => r()));

  for (const status of ["PENDING", "ACTIVE", "DENIED", "BLOCKED"]) {
    it(`purges a ${status} user and audits it with their email`, async () => {
      current!.approvalStatus = status;

      await AdminSvc.deleteUser("user-1", "admin-1");

      expect(purged).to.deep.equal(["user-1"]);
      expect(audits).to.deep.equal([
        { actorId: "admin-1", action: "users.deleted", payload: { userId: "user-1", email: "user@example.com" } },
      ]);
    });
  }

  it("refuses the caller's own account (403), without purging", async () => {
    current!.id = "admin-1";
    current!.role = "ADMIN";

    expect(await statusOf(AdminSvc.deleteUser("admin-1", "admin-1"))).to.equal(403);
    expect(purged).to.have.length(0);
    expect(audits).to.have.length(0);
  });

  it("refuses another admin account (403), without purging", async () => {
    current!.role = "ADMIN";

    expect(await statusOf(AdminSvc.deleteUser("user-1", "admin-1"))).to.equal(403);
    expect(purged).to.have.length(0);
  });

  it("404s for an unknown user", async () => {
    current = null;

    expect(await statusOf(AdminSvc.deleteUser("missing", "admin-1"))).to.equal(404);
    expect(purged).to.have.length(0);
  });
});
