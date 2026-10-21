/** LawyerVerificationSvc.verify / .reject — POST /api/admin/lawyers/:id/verify and /reject.
 * An admin accepts or rejects a lawyer's client-request profile (#506). No register check yet
 * (business decision, 2026-10-21) — the admin's say-so is what moves PENDING to VERIFIED or
 * REJECTED; rejection always carries a reason the lawyer can act on.
 *
 * No live Postgres/Redis: repos, mailer and template are monkeypatched on their CommonJS module
 * objects, same idiom as test/admin-change-tenant.spec.ts and test/signup-auto-approve.spec.ts.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import LawyerVerificationSvc from "../src/services/lawyer-verification.service";
import LawyerProfileRepo from "../src/repositories/lawyer-profile.repository";
import AuthRepo from "../src/repositories/auth.repository";
import SecurityAuditSvc from "../src/services/security-audit.service";
import * as mailerModule from "../src/utils/mailer";
import * as templateModule from "../src/utils/template";
import { rejectLawyerSchema } from "../src/validation/admin.validation";

function stash<T extends object>(target: T, keys: (keyof T)[]) {
  const saved = keys.map((k) => [k, target[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

type StubProfile = { userId: string; verificationStatus: string; verificationNote: string | null; verifiedAt: Date | null };

describe("LawyerVerificationSvc", () => {
  let restore: (() => void)[];
  let current: StubProfile | null;
  let writes: { userId: string; data: any }[];
  let audits: { actorId?: string | null; action: string; targetType?: string; targetId?: string; payload?: object }[];
  let emails: { to: string; subject: string }[];
  let renderedTemplates: { name: string; vars: Record<string, unknown> }[];

  beforeEach(() => {
    current = { userId: "lawyer-1", verificationStatus: "PENDING", verificationNote: null, verifiedAt: null };
    writes = [];
    audits = [];
    emails = [];
    renderedTemplates = [];

    restore = [
      stash(LawyerProfileRepo, ["find", "setVerification"]),
      stash(AuthRepo, ["findById"]),
      stash(SecurityAuditSvc, ["record"]),
      stash(mailerModule as any, ["sendEmail"]),
      stash(templateModule as any, ["renderTemplate"]),
    ];

    (LawyerProfileRepo as any).find = async (userId: string) => (current && userId === current.userId ? { ...current } : null);
    (LawyerProfileRepo as any).setVerification = async (userId: string, data: any) => {
      writes.push({ userId, data });
      current = { ...current!, ...data };
      return { ...current };
    };
    (AuthRepo as any).findById = async (id: string) => (current && id === current.userId ? { id, name: "Jane Lawyer", email: "jane@example.com" } : null);
    (SecurityAuditSvc as any).record = async (data: any) => void audits.push(data);
    (mailerModule as any).sendEmail = async (opts: { to: string; subject: string }) => void emails.push(opts);
    (templateModule as any).renderTemplate = async (name: string, vars: Record<string, unknown>) => {
      renderedTemplates.push({ name, vars });
      return "<html></html>";
    };
  });

  afterEach(() => restore.forEach((r) => r()));

  describe("verify", () => {
    it("verifies a PENDING profile, audits it, and emails the lawyer", async () => {
      const result = await LawyerVerificationSvc.verify("lawyer-1", "admin-1");

      expect(result.verificationStatus).to.equal("VERIFIED");
      expect(result.verificationNote).to.equal(null);
      expect(writes).to.have.length(1);
      expect(writes[0].data.verificationStatus).to.equal("VERIFIED");
      expect(writes[0].data.verificationNote).to.equal(null);
      expect(audits).to.deep.equal([
        {
          action: "admin.lawyer.verified",
          actorId: "admin-1",
          targetType: "user",
          targetId: "lawyer-1",
          payload: { from: "PENDING", to: "VERIFIED" },
        },
      ]);
      expect(emails.map(({ to, subject }) => ({ to, subject }))).to.deep.equal([
        { to: "jane@example.com", subject: "Your SRA registration has been verified" },
      ]);
      expect(renderedTemplates[0].name).to.equal("lawyer-verification-approved");
    });

    it("refuses to verify a profile that isn't PENDING (409), without writing", async () => {
      current!.verificationStatus = "VERIFIED";
      let threw: any;
      try {
        await LawyerVerificationSvc.verify("lawyer-1", "admin-1");
      } catch (e) {
        threw = e;
      }
      expect(threw?.statusCode).to.equal(409);
      expect(writes).to.have.length(0);
      expect(audits).to.have.length(0);
      expect(emails).to.have.length(0);
    });

    it("404s for an unknown profile", async () => {
      current = null;
      let threw: any;
      try {
        await LawyerVerificationSvc.verify("missing", "admin-1");
      } catch (e) {
        threw = e;
      }
      expect(threw?.statusCode).to.equal(404);
    });
  });

  describe("reject", () => {
    it("rejects a PENDING profile with a canned reason, audits it, and emails the lawyer", async () => {
      const result = await LawyerVerificationSvc.reject("lawyer-1", "NAME_MISMATCH", undefined, "admin-1");

      expect(result.verificationStatus).to.equal("REJECTED");
      expect(result.verificationNote).to.equal("The name on your profile doesn't match the regulator's register.");
      expect(result.verifiedAt).to.equal(null);
      expect(audits).to.deep.equal([
        {
          action: "admin.lawyer.rejected",
          actorId: "admin-1",
          targetType: "user",
          targetId: "lawyer-1",
          payload: { from: "PENDING", to: "REJECTED", reason: "NAME_MISMATCH" },
        },
      ]);
      expect(emails.map(({ to, subject }) => ({ to, subject }))).to.deep.equal([
        { to: "jane@example.com", subject: "Your SRA registration could not be verified" },
      ]);
      expect(renderedTemplates[0].vars.reason).to.equal("The name on your profile doesn't match the regulator's register.");
    });

    it("appends the admin's extra detail to a canned reason", async () => {
      const result = await LawyerVerificationSvc.reject("lawyer-1", "WRONG_JURISDICTION", "Register shows England only.", "admin-1");

      expect(result.verificationNote).to.equal(
        "The jurisdiction you selected doesn't match the regulator's register. Register shows England only."
      );
    });

    it("uses the admin's note verbatim for OTHER", async () => {
      const result = await LawyerVerificationSvc.reject("lawyer-1", "OTHER", "Submitted details are for a different person.", "admin-1");

      expect(result.verificationNote).to.equal("Submitted details are for a different person.");
    });

    it("refuses to reject a profile that isn't PENDING (409), without writing", async () => {
      current!.verificationStatus = "REJECTED";
      let threw: any;
      try {
        await LawyerVerificationSvc.reject("lawyer-1", "NOT_PRACTISING", undefined, "admin-1");
      } catch (e) {
        threw = e;
      }
      expect(threw?.statusCode).to.equal(409);
      expect(writes).to.have.length(0);
      expect(audits).to.have.length(0);
    });

    it("404s for an unknown profile", async () => {
      current = null;
      let threw: any;
      try {
        await LawyerVerificationSvc.reject("missing", "NAME_MISMATCH", undefined, "admin-1");
      } catch (e) {
        threw = e;
      }
      expect(threw?.statusCode).to.equal(404);
    });
  });
});

describe("rejectLawyerSchema", () => {
  it("accepts a canned reason without a note", () => {
    expect(rejectLawyerSchema.validate({ reason: "NAME_MISMATCH" }).error).to.equal(undefined);
  });

  it("accepts a canned reason with extra detail", () => {
    expect(rejectLawyerSchema.validate({ reason: "NOT_PRACTISING", note: "Lapsed in 2024" }).error).to.equal(undefined);
  });

  it("requires a note when the reason is OTHER", () => {
    expect(rejectLawyerSchema.validate({ reason: "OTHER" }).error).to.exist;
    expect(rejectLawyerSchema.validate({ reason: "OTHER", note: "" }).error).to.exist;
    expect(rejectLawyerSchema.validate({ reason: "OTHER", note: "Some other issue" }).error).to.equal(undefined);
  });

  it("requires a reason", () => {
    expect(rejectLawyerSchema.validate({}).error).to.exist;
  });

  it("rejects an unknown reason", () => {
    expect(rejectLawyerSchema.validate({ reason: "MADE_UP" }).error).to.exist;
  });
});
