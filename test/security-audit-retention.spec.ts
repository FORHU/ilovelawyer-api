/** SecurityAuditRetentionQueue and securityAuditRetentionDays — how long security audit rows are
 * kept and how the sweep removes older ones. SecurityAuditRepo is monkeypatched, so no live
 * Postgres (the database's own refusal to delete rows under 365 days old is in the migration).
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import SecurityAuditRetentionQueue from "../src/queues/security-audit-retention.queue";
import SecurityAuditRepo from "../src/repositories/security-audit.repository";
import { securityAuditRetentionDays } from "../src/constants/security-audit.constants";

describe("securityAuditRetentionDays", () => {
  it("defaults to 7 years", () => {
    expect(securityAuditRetentionDays(undefined)).to.equal(2555);
    expect(securityAuditRetentionDays("not a number")).to.equal(2555);
  });

  it("takes a longer setting as given, and raises a shorter one to the 365-day floor", () => {
    expect(securityAuditRetentionDays("3650")).to.equal(3650);
    expect(securityAuditRetentionDays("30")).to.equal(365);
  });
});

describe("SecurityAuditRetentionQueue.tick", () => {
  const original = SecurityAuditRepo.deleteOlderThan;
  const originalEnv = process.env.SECURITY_AUDIT_RETENTION_DAYS;
  let calls: { cutoff: Date; take: number }[];
  let batches: number[];

  beforeEach(() => {
    calls = [];
    batches = [1000, 1000, 12];
    delete process.env.SECURITY_AUDIT_RETENTION_DAYS;
    (SecurityAuditRepo as any).deleteOlderThan = async (cutoff: Date, take: number) => {
      calls.push({ cutoff, take });
      return batches.shift() ?? 0;
    };
  });

  afterEach(() => {
    (SecurityAuditRepo as any).deleteOlderThan = original;
    if (originalEnv === undefined) delete process.env.SECURITY_AUDIT_RETENTION_DAYS;
    else process.env.SECURITY_AUDIT_RETENTION_DAYS = originalEnv;
  });

  it("deletes in batches until a short batch, everything older than the retention period", async () => {
    const now = new Date("2033-01-01T03:00:00.000Z");
    const deleted = await SecurityAuditRetentionQueue.tick(now);

    expect(deleted).to.equal(2012);
    expect(calls).to.have.length(3);
    expect(calls.every((c) => c.take === 1000)).to.equal(true);
    expect(calls[0]!.cutoff.toISOString()).to.equal(new Date(now.getTime() - 2555 * 24 * 60 * 60 * 1000).toISOString());
  });

  it("never sweeps closer than the floor, whatever the setting", async () => {
    process.env.SECURITY_AUDIT_RETENTION_DAYS = "7";
    const now = new Date("2030-06-01T00:00:00.000Z");
    batches = [0];

    await SecurityAuditRetentionQueue.tick(now);

    expect(calls[0]!.cutoff.toISOString()).to.equal(new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000).toISOString());
  });
});
