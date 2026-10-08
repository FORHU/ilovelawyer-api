/** AuditSvc — the central, failure-safe writer for security events. No live Postgres: the repo
 * method is monkeypatched on its CommonJS module object, same idiom as
 * test/admin-change-tenant.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import AuditSvc, { AuditAction, scrubAuditPayload } from "../src/services/audit.service";
import OrganizationRepo from "../src/repositories/organization.repository";

describe("scrubAuditPayload", () => {
  it("redacts credential-looking keys at any depth and leaves the rest", () => {
    const out = scrubAuditPayload({
      id: "u1",
      password: "hunter2",
      nested: { refreshToken: "abc", keep: 3 },
      list: [{ apiKey: "k", ok: true }],
    });
    expect(out).to.deep.equal({
      id: "u1",
      password: "[redacted]",
      nested: { refreshToken: "[redacted]", keep: 3 },
      list: [{ apiKey: "[redacted]", ok: true }],
    });
  });

  it("keeps dates and primitives intact", () => {
    const when = new Date("2026-10-08T00:00:00Z");
    expect(scrubAuditPayload({ when, n: 1, s: "x", z: null })).to.deep.equal({ when, n: 1, s: "x", z: null });
  });

  it("truncates absurdly deep objects instead of recursing forever", () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    expect(JSON.stringify(scrubAuditPayload(deep))).to.include("[truncated]");
  });
});

describe("AuditSvc.record", () => {
  const original = OrganizationRepo.writeAudit;
  let written: Array<Record<string, unknown>>;

  beforeEach(() => {
    written = [];
    OrganizationRepo.writeAudit = (async (data: Record<string, unknown>) => {
      written.push(data);
      return {} as never;
    }) as typeof OrganizationRepo.writeAudit;
  });
  afterEach(() => {
    OrganizationRepo.writeAudit = original;
  });

  it("writes the action, actor and a scrubbed payload", async () => {
    await AuditSvc.record({ action: AuditAction.PasswordChanged, actorId: "u1", payload: { token: "t", via: "settings" } });
    expect(written).to.have.length(1);
    expect(written[0]).to.deep.include({ action: "auth.password_changed", actorId: "u1" });
    expect(written[0].payload).to.deep.equal({ token: "[redacted]", via: "settings" });
  });

  it("never throws when the write fails", async () => {
    OrganizationRepo.writeAudit = (async () => {
      throw new Error("db down");
    }) as typeof OrganizationRepo.writeAudit;
    await AuditSvc.record({ action: AuditAction.FileDownloaded, payload: { s3Key: "k" } });
  });
});
