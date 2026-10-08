/** BulkApprovalRunner — "Approve all pending" on the admin Settings page. Runs each approvable
 * PENDING user of one Tenant through AdminSvc.approve in the background, guarded by a
 * per-Tenant Redis lock, with progress kept in Redis for the page to poll.
 *
 * No live Postgres/Redis: AdminSvc.approve, the repos and the redis wrapper are monkeypatched
 * on their CommonJS module objects, same idiom as test/admin-session-revocation.spec.ts.
 * The run is fire-and-forget, so each test waits for its final audit write.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import BulkApprovalRunner, { type BulkApprovalProgress } from "../src/queues/bulk-approval.runner";
import AdminSvc from "../src/services/admin.service";
import AuthRepo from "../src/repositories/auth.repository";
import TenantRepo from "../src/repositories/tenant.repository";
import SecurityAuditSvc from "../src/services/security-audit.service";
import HttpError from "../src/utils/http-error";
import { redis } from "../src/lib/redis";

function stash<T extends object>(target: T, keys: (keyof T)[]) {
  const saved = keys.map((k) => [k, target[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

describe("BulkApprovalRunner", () => {
  let restore: (() => void)[];
  let store: Map<string, unknown>;
  let redisDown: boolean;
  let pendingIds: string[];
  let approveOutcome: (id: string) => Promise<unknown>;
  let approvedIds: string[];
  let approvedBy: (string | undefined)[];
  let audits: { actorId?: string; action: string; payload?: any }[];
  let finished: Promise<void>;
  let markFinished: () => void;

  beforeEach(() => {
    store = new Map();
    redisDown = false;
    pendingIds = ["u1", "u2", "u3", "u4", "u5", "u6", "u7"];
    approvedIds = [];
    approvedBy = [];
    audits = [];
    approveOutcome = async () => ({});
    finished = new Promise((resolve) => (markFinished = resolve));

    restore = [
      stash(redis, ["get", "set", "del", "setIfAbsent"]),
      stash(AdminSvc, ["approve"]),
      stash(AuthRepo, ["findApprovablePendingIds"]),
      stash(TenantRepo, ["findByCode"]),
      stash(SecurityAuditSvc, ["record"]),
    ];

    (redis as any).get = async (key: string) => (store.has(key) ? structuredClone(store.get(key)) : null);
    (redis as any).set = async (key: string, value: unknown) => void store.set(key, structuredClone(value));
    (redis as any).del = async (key: string) => void store.delete(key);
    (redis as any).setIfAbsent = async (key: string, value: unknown) => {
      if (redisDown) return null;
      if (store.has(key)) return false;
      store.set(key, value);
      return true;
    };
    (AdminSvc as any).approve = async (id: string, adminId?: string) => {
      approvedBy.push(adminId);
      const result = await approveOutcome(id);
      approvedIds.push(id);
      return result;
    };
    (AuthRepo as any).findApprovablePendingIds = async (tenantId: string) => (tenantId === "tenant-ph" ? pendingIds : []);
    (TenantRepo as any).findByCode = async (code: string) =>
      code === "PH" ? { id: "tenant-ph", code: "PH", name: "Philippines" } : code === "UK" ? { id: "tenant-uk", code: "UK", name: "United Kingdom" } : null;
    (SecurityAuditSvc as any).record = async (data: any) => {
      audits.push(data);
      markFinished();
    };
  });

  afterEach(() => restore.forEach((r) => r()));

  it("approves every pending user, then records final counts, releases the lock and audits once", async () => {
    const { total } = await BulkApprovalRunner.start("PH", "admin-1");
    expect(total).to.equal(7);

    await finished;

    expect(approvedIds).to.have.members(pendingIds);
    const progress = (await BulkApprovalRunner.getProgress("PH")) as BulkApprovalProgress;
    expect(progress).to.include({ status: "done", total: 7, done: 7, approved: 7, skipped: 0, failed: 0, startedById: "admin-1" });
    expect(progress.finishedAt).to.be.a("string");
    expect(store.has("bulk-approve:PH:lock")).to.equal(false);
    // Each approval names the admin who started the run (it writes its own admin.user.approved row
    // — stubbed out here), and the run ends with one summary row.
    expect(approvedBy).to.deep.equal(pendingIds.map(() => "admin-1"));
    expect(audits).to.deep.equal([
      {
        action: "admin.user.approved",
        actorId: "admin-1",
        organizationId: null,
        targetType: "tenant",
        targetId: "PH",
        payload: { bulk: true, total: 7, approved: 7, skipped: 0, failed: 0 },
      },
    ]);
  });

  it("counts users moved out of PENDING mid-run as skipped, and other errors as failed", async () => {
    approveOutcome = async (id) => {
      if (id === "u2") throw new HttpError("Cannot approve: account is DENIED, not PENDING", 409);
      if (id === "u5") throw new Error("SMTP timeout");
      return {};
    };

    await BulkApprovalRunner.start("PH", "admin-1");
    await finished;

    const progress = (await BulkApprovalRunner.getProgress("PH")) as BulkApprovalProgress;
    expect(progress).to.include({ status: "done", done: 7, approved: 5, skipped: 1, failed: 1 });
  });

  it("refuses a second run for the same Tenant while one is going (409)", async () => {
    store.set("bulk-approve:PH:lock", { adminId: "admin-2" });

    let threw: any;
    try {
      await BulkApprovalRunner.start("PH", "admin-1");
    } catch (e) {
      threw = e;
    }
    expect(threw?.statusCode).to.equal(409);
    expect(approvedIds).to.have.length(0);
  });

  it("doesn't block another Tenant's run", async () => {
    store.set("bulk-approve:UK:lock", { adminId: "admin-2" });
    const { total } = await BulkApprovalRunner.start("PH", "admin-1");
    expect(total).to.equal(7);
    await finished;
  });

  it("refuses to start without Redis, since there'd be no lock (503)", async () => {
    redisDown = true;

    let threw: any;
    try {
      await BulkApprovalRunner.start("PH", "admin-1");
    } catch (e) {
      threw = e;
    }
    expect(threw?.statusCode).to.equal(503);
    expect(approvedIds).to.have.length(0);
  });

  it("returns 0 and releases the lock straight away when nothing is pending", async () => {
    const { total } = await BulkApprovalRunner.start("UK", "admin-1");
    expect(total).to.equal(0);
    expect(store.has("bulk-approve:UK:lock")).to.equal(false);
    expect(await BulkApprovalRunner.getProgress("UK")).to.equal(null);
  });
});
