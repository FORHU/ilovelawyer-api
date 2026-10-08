/** SecurityAuditSvc — how a row is filled in (request context, actor email snapshot, which
 * organization it belongs to), that recording never throws, and the CSV export. No live Postgres:
 * SecurityAuditRepo is monkeypatched on its CommonJS module object, same idiom as
 * test/admin-delete-user.spec.ts.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import SecurityAuditSvc, { csvCell } from "../src/services/security-audit.service";
import SecurityAuditRepo from "../src/repositories/security-audit.repository";
import { runWithRequestContext, RequestContext } from "../src/lib/request-context";
import HttpError from "../src/utils/http-error";
import logger from "../src/utils/logger";

function stash<T extends object>(target: T, keys: (keyof T)[]) {
  const saved = keys.map((k) => [k, target[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

function context(overrides: Partial<{ userId: string | null; organizationId: string | null; tenantCode: string | null }> = {}): RequestContext {
  const values = { userId: "user-1", organizationId: null, tenantCode: null, ...overrides };
  return {
    requestId: "req-1",
    ip: "203.0.113.7",
    userAgent: "Mozilla/5.0",
    userId: () => values.userId,
    organizationId: () => values.organizationId,
    tenantCode: () => values.tenantCode,
  };
}

type UserInfo = { email: string; organizationMemberships: { organizationId: string; organization: { tenant: { code: string } } }[] };

describe("SecurityAuditSvc.record", () => {
  let restore: (() => void)[];
  let rows: any[];
  let users: Record<string, UserInfo>;
  let emails: Record<string, string>;
  let errors: unknown[];

  beforeEach(() => {
    rows = [];
    errors = [];
    users = {
      "user-1": { email: "lawyer@firm.test", organizationMemberships: [{ organizationId: "org-1", organization: { tenant: { code: "UK" } } }] },
      "admin-1": { email: "ops@ilovelawyer.test", organizationMemberships: [] },
      "user-2": { email: "member@firm.test", organizationMemberships: [{ organizationId: "org-2", organization: { tenant: { code: "PH" } } }] },
    };
    emails = { "member@firm.test": "user-2" };
    restore = [
      stash(SecurityAuditRepo, ["create", "findUserAuditInfo", "findUserIdByEmail", "findOrganizationTenantCode"]),
      stash(logger, ["error"]),
    ];
    (SecurityAuditRepo as any).create = async (data: any) => void rows.push(data);
    (SecurityAuditRepo as any).findUserAuditInfo = async (id: string) => users[id] ?? null;
    (SecurityAuditRepo as any).findUserIdByEmail = async (email: string) => emails[email] ?? null;
    (SecurityAuditRepo as any).findOrganizationTenantCode = async (id: string) => (id === "org-9" ? "PH" : null);
    (logger as any).error = (message: string, meta: unknown) => void errors.push({ message, meta });
  });

  afterEach(() => restore.forEach((r) => r()));

  it("fills actor, ip, user agent and request id from the request, and snapshots the actor's email", async () => {
    await runWithRequestContext(context({ organizationId: "org-1", tenantCode: "UK" }), () =>
      SecurityAuditSvc.record({ action: "org.updated", targetType: "organization", targetId: "org-1", payload: { fields: ["name"] } }),
    );

    expect(rows).to.deep.equal([
      {
        action: "org.updated",
        outcome: "SUCCESS",
        organizationId: "org-1",
        tenantCode: "UK",
        actorId: "user-1",
        actorEmail: "lawyer@firm.test",
        targetType: "organization",
        targetId: "org-1",
        caseId: null,
        ip: "203.0.113.7",
        userAgent: "Mozilla/5.0",
        requestId: "req-1",
        payload: { fields: ["name"] },
      },
    ]);
  });

  it("falls back to the actor's own organization when the request resolved none", async () => {
    await runWithRequestContext(context(), () => SecurityAuditSvc.record({ action: "auth.logout" }));
    expect(rows[0]).to.include({ organizationId: "org-1", tenantCode: "UK", actorId: "user-1" });
  });

  it("files a platform admin's action on a user under that user's organization", async () => {
    await SecurityAuditSvc.record({ action: "admin.user.blocked", actorId: "admin-1", targetType: "user", targetId: "user-2" });
    expect(rows[0]).to.include({ organizationId: "org-2", tenantCode: "PH", actorEmail: "ops@ilovelawyer.test" });
  });

  it("keeps an explicit organization (even null) over every fallback, and looks up its tenant", async () => {
    await runWithRequestContext(context({ organizationId: "org-1", tenantCode: "UK" }), async () => {
      await SecurityAuditSvc.record({ action: "org.member_removed", organizationId: "org-9" });
      await SecurityAuditSvc.record({ action: "admin.jurisdiction_module.toggled", organizationId: null });
    });
    expect(rows[0]).to.include({ organizationId: "org-9", tenantCode: "PH" });
    expect(rows[1]).to.include({ organizationId: null, tenantCode: null });
  });

  it("records a failed sign-in against the account the typed email names, with the refusal's reason", async () => {
    await runWithRequestContext(context({ userId: null }), () =>
      SecurityAuditSvc.recordFailure(
        { action: "auth.login", actorId: null, attemptedEmail: "  Member@Firm.test ", payload: { method: "password" } },
        new HttpError("Invalid email or password", 401),
      ),
    );

    expect(rows[0]).to.deep.include({
      action: "auth.login",
      outcome: "FAILURE",
      actorId: null,
      actorEmail: null,
      targetType: "user",
      targetId: "user-2",
      organizationId: "org-2",
      payload: { method: "password", email: "member@firm.test", reason: "Invalid email or password", status: 401 },
    });
  });

  it("keeps an unknown email in the payload with no target or organization", async () => {
    await SecurityAuditSvc.recordFailure({ action: "auth.login", actorId: null, attemptedEmail: "nobody@x.test" }, new Error("boom"));
    expect(rows[0]).to.deep.include({ targetId: null, organizationId: null, payload: { email: "nobody@x.test", reason: "internal_error" } });
  });

  it("never throws: a failed write is logged with the whole event instead", async () => {
    (SecurityAuditRepo as any).create = async () => {
      throw new Error("db down");
    };
    await SecurityAuditSvc.record({ action: "case.deleted", actorId: "user-1", caseId: "case-1" });
    expect(errors).to.have.length(1);
    expect((errors[0] as any).meta.event).to.include({ action: "case.deleted", caseId: "case-1" });
  });
});

describe("SecurityAuditSvc.list and exportCsv", () => {
  let restore: (() => void)[];
  let recorded: any[];
  let pageCalls: { filter: unknown; take: number; cursor?: string }[];

  const row = (i: number) => ({
    id: `row-${i}`,
    createdAt: new Date(Date.UTC(2026, 9, 8, 10, 0, i)),
    action: "auth.login",
    outcome: "SUCCESS",
    organizationId: "org-1",
    tenantCode: "UK",
    actorId: "user-1",
    actorEmail: "lawyer@firm.test",
    targetType: null,
    targetId: null,
    caseId: null,
    ip: "203.0.113.7",
    userAgent: "Mozilla/5.0",
    requestId: "req",
    payload: { method: "password" },
  });

  beforeEach(() => {
    recorded = [];
    pageCalls = [];
    restore = [stash(SecurityAuditRepo, ["list"]), stash(SecurityAuditSvc, ["record"])];
    (SecurityAuditSvc as any).record = async (data: unknown) => void recorded.push(data);
  });

  afterEach(() => restore.forEach((r) => r()));

  it("returns a page and the cursor for the next one", async () => {
    (SecurityAuditRepo as any).list = async (filter: unknown, take: number, cursor?: string) => {
      pageCalls.push({ filter, take, cursor });
      return [row(1), row(2), row(3)];
    };
    const result = await SecurityAuditSvc.list({ organizationId: "org-1" }, 2, "row-0");
    expect(pageCalls).to.deep.equal([{ filter: { organizationId: "org-1" }, take: 3, cursor: "row-0" }]);
    expect(result.events.map((e) => e.id)).to.deep.equal(["row-1", "row-2"]);
    expect(result.nextCursor).to.equal("row-2");
  });

  it("returns no cursor on the last page", async () => {
    (SecurityAuditRepo as any).list = async () => [row(1)];
    expect((await SecurityAuditSvc.list({}, 2)).nextCursor).to.equal(null);
  });

  it("exports every page as CSV and records the export itself", async () => {
    const pages = [Array.from({ length: 1000 }, (_, i) => row(i)), [row(1000)]];
    (SecurityAuditRepo as any).list = async (_filter: unknown, _take: number, cursor?: string) => {
      pageCalls.push({ filter: null, take: _take, cursor });
      return pages.shift() ?? [];
    };

    const { csv, rowCount, truncated } = await SecurityAuditSvc.exportCsv({ organizationId: "org-1", action: "auth." });

    expect(rowCount).to.equal(1001);
    expect(truncated).to.equal(false);
    expect(pageCalls.map((c) => c.cursor)).to.deep.equal([undefined, "row-999"]);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).to.equal(
      "createdAt,action,outcome,actorEmail,actorId,targetType,targetId,caseId,organizationId,ip,userAgent,requestId,payload",
    );
    expect(lines[1]).to.equal(
      '2026-10-08T10:00:00.000Z,auth.login,SUCCESS,lawyer@firm.test,user-1,,,,org-1,203.0.113.7,Mozilla/5.0,req,"{""method"":""password""}"',
    );
    expect(recorded).to.deep.equal([
      {
        action: "export.audit_log",
        organizationId: "org-1",
        targetType: "organization",
        targetId: "org-1",
        payload: { rowCount: 1001, truncated: false, filter: { action: "auth." } },
      },
    ]);
  });
});

describe("csvCell", () => {
  it("quotes commas, quotes and newlines", () => {
    expect(csvCell('a,"b"\nc')).to.equal('"a,""b""\nc"');
  });

  it("defuses spreadsheet formulas in attacker-controlled text", () => {
    expect(csvCell("=HYPERLINK(\"http://evil\")")).to.equal('"\'=HYPERLINK(""http://evil"")"');
    expect(csvCell("+1")).to.equal("'+1");
    expect(csvCell("@SUM(A1)")).to.equal("'@SUM(A1)");
  });

  it("writes null as empty and dates as ISO", () => {
    expect(csvCell(null)).to.equal("");
    expect(csvCell(new Date(Date.UTC(2026, 0, 2)))).to.equal("2026-01-02T00:00:00.000Z");
  });
});
