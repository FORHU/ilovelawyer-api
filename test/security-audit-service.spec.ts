/** SecurityAuditSvc — how a row is filled in (request context, actor email snapshot, which
 * organization it belongs to), that recording never throws, and the CSV export. No live Postgres:
 * SecurityAuditRepo is monkeypatched on its CommonJS module object, same idiom as
 * test/admin-delete-user.spec.ts.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import SecurityAuditSvc from "../src/services/security-audit.service";
import * as pdfRenderer from "../src/utils/audit-log-pdf-renderer";
import SecurityAuditRepo, { DEFAULT_SECURITY_AUDIT_SORT, securityAuditOrderBy } from "../src/repositories/security-audit.repository";
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
        targetName: null,
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

describe("SecurityAuditSvc.list and exportPdf", () => {
  let restore: (() => void)[];
  let recorded: any[];
  let listCalls: { take: number; skip: number }[];
  let rendered: { header: any; events: any[] }[];

  const row = (i: number) => ({
    id: `row-${i}`,
    createdAt: new Date(Date.UTC(2026, 9, 8, 10, 0, i % 60)),
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
    listCalls = [];
    rendered = [];
    restore = [
      stash(SecurityAuditRepo, ["list", "count"]),
      stash(SecurityAuditSvc, ["record"]),
      stash(pdfRenderer, ["renderAuditLogPdf"]),
    ];
    (SecurityAuditSvc as any).record = async (data: unknown) => void recorded.push(data);
    (pdfRenderer as any).renderAuditLogPdf = async (header: unknown, events: any[]) => {
      rendered.push({ header, events });
      return Buffer.from("%PDF-test");
    };
  });

  afterEach(() => restore.forEach((r) => r()));

  it("returns the requested page with the totals pagination needs", async () => {
    (SecurityAuditRepo as any).list = async (_filter: unknown, take: number, skip: number) => {
      listCalls.push({ take, skip });
      return [row(51), row(52)];
    };
    (SecurityAuditRepo as any).count = async () => 52;

    const result = await SecurityAuditSvc.list({ organizationId: "org-1" }, 3, 25);

    expect(listCalls).to.deep.equal([{ take: 25, skip: 50 }]);
    expect(result).to.include({ total: 52, page: 3, pageSize: 25, totalPages: 3 });
    expect(result.events.map((e) => e.id)).to.deep.equal(["row-51", "row-52"]);
    // Only what the table shows goes out: no actor, target, case or organization ids.
    expect(Object.keys(result.events[0]!).sort()).to.deep.equal(["action", "createdAt", "display", "id", "outcome", "requestId"]);
    expect(result.events[0]!.display).to.deep.equal({ actor: "lawyer@firm.test", target: "N/A", details: "With password" });
  });

  it("reports one page for an empty log", async () => {
    (SecurityAuditRepo as any).list = async () => [];
    (SecurityAuditRepo as any).count = async () => 0;
    expect((await SecurityAuditSvc.list({}, 1, 25)).totalPages).to.equal(1);
  });

  it("exports every matching row as a PDF and records the export itself", async () => {
    const all = Array.from({ length: 1500 }, (_, i) => row(i));
    (SecurityAuditRepo as any).count = async () => all.length;
    (SecurityAuditRepo as any).list = async (_filter: unknown, take: number, skip: number) => {
      listCalls.push({ take, skip });
      return all.slice(skip, skip + take);
    };

    const { pdf, rowCount, truncated } = await SecurityAuditSvc.exportPdf({ organizationId: "org-1", action: "auth." }, "Audit QA Firm");

    expect(pdf.toString()).to.equal("%PDF-test");
    expect(rowCount).to.equal(1500);
    expect(truncated).to.equal(false);
    expect(listCalls).to.deep.equal([
      { take: 1000, skip: 0 },
      { take: 500, skip: 1000 },
    ]);
    expect(rendered[0]!.events).to.have.length(1500);
    expect(rendered[0]!.events[0].display.details).to.equal("With password");
    expect(rendered[0]!.header).to.include({ scope: "Audit QA Firm", rowCount: 1500, truncated: false, sort: "newest first" });
    expect(rendered[0]!.header.filterSummary).to.equal("Sign-in");
    expect(recorded).to.deep.equal([
      {
        action: "export.audit_log",
        organizationId: "org-1",
        targetType: "organization",
        targetId: "org-1",
        payload: { format: "pdf", rowCount: 1500, truncated: false, filter: { action: "auth." } },
      },
    ]);
  });

  it("caps the export at 5,000 rows and says so", async () => {
    (SecurityAuditRepo as any).count = async () => 7000;
    (SecurityAuditRepo as any).list = async (_filter: unknown, take: number, skip: number) =>
      Array.from({ length: take }, (_, i) => row(skip + i));

    const { rowCount, truncated } = await SecurityAuditSvc.exportPdf({ organizationId: "org-1" }, "Audit QA Firm");

    expect(rowCount).to.equal(5000);
    expect(truncated).to.equal(true);
    expect(rendered[0]!.header).to.include({ rowCount: 7000, truncated: true, maxRows: 5000 });
  });
});

describe("securityAuditOrderBy", () => {
  it("defaults to newest first, with the id as a tie-break so pages never overlap", () => {
    expect(securityAuditOrderBy(DEFAULT_SECURITY_AUDIT_SORT)).to.deep.equal([{ createdAt: "desc" }, { id: "desc" }]);
    expect(securityAuditOrderBy({ field: "time", direction: "asc" })).to.deep.equal([{ createdAt: "asc" }, { id: "desc" }]);
  });

  it("groups by action or by who did it, newest first within each group, with no-actor rows last", () => {
    expect(securityAuditOrderBy({ field: "action", direction: "asc" })).to.deep.equal([{ action: "asc" }, { createdAt: "desc" }, { id: "desc" }]);
    expect(securityAuditOrderBy({ field: "actor", direction: "desc" })).to.deep.equal([
      { actorEmail: { sort: "desc", nulls: "last" } },
      { createdAt: "desc" },
      { id: "desc" },
    ]);
  });
});

describe("SecurityAuditSvc sorting", () => {
  let restore: (() => void)[];
  let sorts: unknown[];
  let header: any;

  beforeEach(() => {
    sorts = [];
    restore = [stash(SecurityAuditRepo, ["list", "count"]), stash(SecurityAuditSvc, ["record"]), stash(pdfRenderer, ["renderAuditLogPdf"])];
    (SecurityAuditRepo as any).list = async (_f: unknown, _t: number, _s: number, sort: unknown) => {
      sorts.push(sort);
      return [];
    };
    (SecurityAuditRepo as any).count = async () => 1;
    (SecurityAuditSvc as any).record = async () => {};
    (pdfRenderer as any).renderAuditLogPdf = async (h: unknown) => {
      header = h;
      return Buffer.from("%PDF");
    };
  });

  afterEach(() => restore.forEach((r) => r()));

  it("passes the chosen order to the page query and the PDF, and names it in the PDF header", async () => {
    await SecurityAuditSvc.list({}, 1, 20, { field: "action", direction: "asc" });
    await SecurityAuditSvc.exportPdf({}, "Audit QA Firm", { field: "actor", direction: "asc" });
    expect(sorts).to.deep.equal([
      { field: "action", direction: "asc" },
      { field: "actor", direction: "asc" },
    ]);
    expect(header.sort).to.equal("by who did it (A–Z)");
  });
});

describe("renderAuditLogPdf", () => {
  /** The page tree's /Count — pdfkit writes it uncompressed. */
  const pageCount = (pdf: Buffer) => Number(/\/Count (\d+)/.exec(pdf.toString("latin1"))?.[1] ?? 0);

  const event = (i: number, overrides: object = {}) =>
    ({
      id: `e-${i}`,
      createdAt: new Date(Date.UTC(2026, 9, 8, 9, 30, 0)),
      action: "org.member_role_changed",
      outcome: "SUCCESS",
      organizationId: "org-1",
      tenantCode: "UK",
      actorId: "user-1",
      actorEmail: "owner@firm.test",
      targetType: "user",
      targetId: "user-2",
      caseId: null,
      ip: "203.0.113.7",
      userAgent: "Mozilla/5.0",
      requestId: "req",
      payload: { from: "MEMBER", to: "ADMIN" },
      ...overrides,
    }) as any;

  const header = {
    scope: "Audit QA Firm",
    generatedAt: new Date(),
    generatedBy: "owner@firm.test",
    filterSummary: "all activity",
    sort: "newest first",
    truncated: false,
    maxRows: 5000,
  };

  const display = { actor: "Owner A", target: "Member B", details: "Member → Admin" };
  const item = (i: number, overrides: object = {}) => ({ event: event(i, overrides), display });

  it("lays an event out as one table row, using the display text rather than ids", () => {
    expect(pdfRenderer.auditLogPdfRow(item(1))).to.deep.equal([
      "8 Oct 2026\n09:30:00",
      "Member role changed",
      "Success",
      "Owner A",
      "Member B",
      // The PDF's built-in font has no arrow, so it's spelled out.
      "Member to Admin",
    ]);
    expect(pdfRenderer.auditLogPdfRow(item(2, { outcome: "FAILURE" }))[2]).to.equal("Failed");
  });

  it("sums up the events for the summary tiles", () => {
    const summary = pdfRenderer.auditLogSummary([
      item(1),
      item(2, { outcome: "FAILURE", actorId: null, createdAt: new Date(Date.UTC(2026, 9, 1)) }),
      item(3, { actorId: "user-9" }),
    ]);
    expect(summary).to.deep.include({ failed: 1, people: 2 });
    expect(summary.period!.from.toISOString()).to.equal("2026-10-01T00:00:00.000Z");
  });

  it("renders a valid multi-page PDF for a long log, and a one-page PDF for an empty one", async () => {
    const long = await pdfRenderer.renderAuditLogPdf({ ...header, rowCount: 300 }, Array.from({ length: 300 }, (_, i) => item(i)));
    expect(long.subarray(0, 5).toString()).to.equal("%PDF-");
    expect(pageCount(long)).to.be.greaterThan(1);

    const empty = await pdfRenderer.renderAuditLogPdf({ ...header, rowCount: 0 }, []);
    expect(pageCount(empty)).to.equal(1);
  });
});
