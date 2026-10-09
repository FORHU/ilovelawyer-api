/** ConsentSvc — what a user has agreed to, per purpose. No live Postgres: the repo is
 * monkeypatched on its CommonJS module object, same idiom as test/admin-change-tenant.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import { ConsentPurpose } from "@prisma/client";
import ConsentSvc from "../src/services/consent.service";
import ConsentRepo from "../src/repositories/consent.repository";
import SecurityAuditSvc from "../src/services/security-audit.service";
import { CONSENT_VERSIONS } from "../src/constants/consent.constants";

type Row = {
  purpose: ConsentPurpose;
  version: string;
  grantedAt: Date;
  withdrawnAt: Date | null;
};

describe("ConsentSvc", () => {
  const original = { findByUser: ConsentRepo.findByUser, findTerms: ConsentRepo.findTerms, set: ConsentRepo.set };
  let rows: Row[];
  let terms: { termsAcceptedAt: Date | null; termsVersion: string | null } | null;
  let sets: Array<{ purpose: ConsentPurpose; granted: boolean; version: string; source: string }>;

  beforeEach(() => {
    rows = [];
    terms = { termsAcceptedAt: null, termsVersion: null };
    sets = [];
    ConsentRepo.findByUser = (async () => rows) as unknown as typeof ConsentRepo.findByUser;
    ConsentRepo.findTerms = (async () => terms) as unknown as typeof ConsentRepo.findTerms;
    ConsentRepo.set = (async (_u: string, purpose: ConsentPurpose, granted: boolean, version: string, source: string) => {
      sets.push({ purpose, granted, version, source });
      rows = rows.filter((r) => r.purpose !== purpose);
      const now = new Date("2026-10-08T00:00:00Z");
      rows.push({ purpose, version, grantedAt: now, withdrawnAt: granted ? null : now });
      return {} as never;
    }) as unknown as typeof ConsentRepo.set;
  });
  afterEach(() => {
    ConsentRepo.findByUser = original.findByUser;
    ConsentRepo.findTerms = original.findTerms;
    ConsentRepo.set = original.set;
  });

  it("lists the purposes the product uses (not analytics or marketing, which it does not), and a purpose never answered is not_set rather than withdrawn", async () => {
    const list = await ConsentSvc.list("u1");
    expect(list.map((c) => c.purpose)).to.deep.equal(["TERMS_OF_SERVICE", "AI_PROCESSING"]);
    expect(list.every((c) => c.status === "not_set" && c.version === null)).to.equal(true);
  });

  it("reports Terms of Service from the user row, flagging an older version as outdated", async () => {
    terms = { termsAcceptedAt: new Date("2026-01-01T00:00:00Z"), termsVersion: "2025-01" };
    const tos = (await ConsentSvc.list("u1")).find((c) => c.purpose === "TERMS_OF_SERVICE")!;
    expect(tos).to.deep.include({ status: "granted", version: "2025-01", outdated: true });

    terms = { termsAcceptedAt: new Date("2026-10-01T00:00:00Z"), termsVersion: CONSENT_VERSIONS.TERMS_OF_SERVICE! };
    const current = (await ConsentSvc.list("u1")).find((c) => c.purpose === "TERMS_OF_SERVICE")!;
    expect(current.outdated).to.equal(false);
  });

  it("grants a purpose at the current version and records where it came from", async () => {
    const list = await ConsentSvc.set("u1", "AI_PROCESSING", true);
    expect(sets).to.deep.equal([{ purpose: "AI_PROCESSING", granted: true, version: CONSENT_VERSIONS.AI_PROCESSING!, source: "settings" }]);
    expect(list.find((c) => c.purpose === "AI_PROCESSING")).to.deep.include({ status: "granted", withdrawnAt: null });
  });

  it("writes each change to the security audit log, since the table keeps only the latest answer", async () => {
    const recorded: Array<Record<string, unknown>> = [];
    const original = SecurityAuditSvc.record;
    SecurityAuditSvc.record = (async (input: Record<string, unknown>) => {
      recorded.push(input);
    }) as unknown as typeof SecurityAuditSvc.record;
    try {
      await ConsentSvc.set("u1", "AI_PROCESSING", true, "first_login");
      await ConsentSvc.set("u1", "AI_PROCESSING", false);
    } finally {
      SecurityAuditSvc.record = original;
    }
    expect(recorded.map((r) => [r.action, r.actorId, r.targetId, (r.payload as { granted: boolean }).granted, (r.payload as { source: string }).source])).to.deep.equal([
      ["consent.changed", "u1", "u1", true, "first_login"],
      ["consent.changed", "u1", "u1", false, "settings"],
    ]);
  });

  it("withdraws a purpose and keeps when it was first granted", async () => {
    rows = [{ purpose: "AI_PROCESSING", version: CONSENT_VERSIONS.AI_PROCESSING!, grantedAt: new Date("2026-09-01T00:00:00Z"), withdrawnAt: null }];
    const list = await ConsentSvc.set("u1", "AI_PROCESSING", false);
    const ai = list.find((c) => c.purpose === "AI_PROCESSING")!;
    expect(ai.status).to.equal("withdrawn");
    expect(ai.grantedAt).to.be.instanceOf(Date);
    expect(ai.outdated).to.equal(false);
  });

  it("flags a granted answer given to an older text as outdated", async () => {
    rows = [{ purpose: "AI_PROCESSING", version: "2025-01", grantedAt: new Date("2025-01-01T00:00:00Z"), withdrawnAt: null }];
    const ai = (await ConsentSvc.list("u1")).find((c) => c.purpose === "AI_PROCESSING")!;
    expect(ai).to.deep.include({ status: "granted", outdated: true });
  });

  it("refuses to change a purpose the product does not use", async () => {
    let status = 0;
    try {
      await ConsentSvc.set("u1", "MARKETING", true);
    } catch (err) {
      status = (err as { statusCode?: number }).statusCode ?? 0;
    }
    expect(status).to.equal(400);
    expect(sets).to.have.length(0);
  });

  it("refuses to change Terms of Service here", async () => {
    let status = 0;
    try {
      await ConsentSvc.set("u1", "TERMS_OF_SERVICE", false);
    } catch (err) {
      status = (err as { statusCode?: number; status?: number }).statusCode ?? (err as { status?: number }).status ?? 0;
    }
    expect(status).to.equal(400);
    expect(sets).to.have.length(0);
  });
});
