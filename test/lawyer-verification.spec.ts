/** LawyerVerificationSvc.list / .verify / .reject — GET /api/admin/lawyer-verifications and
 * POST /api/admin/lawyer-verifications/:userId/verify and /reject.
 * An admin approves or rejects a Lawyer Application, UK or PH (#506). No register check yet
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
import { listLawyerVerificationsSchema, rejectLawyerSchema, verifyLawyerSchema } from "../src/validation/admin.validation";

function stash<T extends object>(target: T, keys: (keyof T)[]) {
  const saved = keys.map((k) => [k, target[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
    return undefined;
  } catch (err: any) {
    return err.statusCode as number;
  }
}

type StubProfile = {
  userId: string;
  country: string;
  verificationStatus: string;
  verificationNote: string | null;
  verifiedAt: Date | null;
  qualifiedJurisdictions: string[];
  ph: Record<string, string | null>;
};

const SUBMITTED_AT = new Date("2026-10-20T09:00:00Z");
const NO_PH = { rollNumber: null, ibpChapter: null, ibpMembershipNumber: null, mcleNumber: null, mclePeriod: null };

type Org = { name: string; isPersonal: boolean } | null;
const FIRM: Org = { name: "Jane & Co", isPersonal: false };

/** A profile as LawyerProfileRepo's admin queries return it: the flattened row plus the user and
 * their organization with its firm details. */
function adminRow(p: StubProfile, org: Org = FIRM) {
  return {
    regulator: "SRA",
    registrationNumber: "123456",
    practiceAreas: [{ id: "uk-employment", name: "Employment Law", caseArea: "EMPLOYMENT", isActive: true, sortOrder: 0 }],
    bio: "",
    languages: [],
    firstConsultationFeeMinor: null,
    acceptingRequests: false,
    enabledByOrganization: true,
    pausedUntil: null,
    capacityLimit: null,
    submittedAt: SUBMITTED_AT,
    createdAt: SUBMITTED_AT,
    updatedAt: SUBMITTED_AT,
    ...p,
    user: {
      name: "Jane Lawyer" as string | null,
      email: "jane@example.com",
      organizationMemberships: org
        ? [
            {
              organization: {
                ...org,
                phone: "020 7946 0000",
                addressLine1: "1 Fleet Street",
                addressLine2: null,
                city: "London",
                postcode: "EC4Y 1AA",
                firmRegulator: "SRA",
                firmRegistrationNumber: "654321",
              },
            },
          ]
        : [],
    },
  };
}

describe("LawyerVerificationSvc", () => {
  let restore: (() => void)[];
  let current: StubProfile | null;
  let writes: { userId: string; data: any; confirmed?: string[] }[];
  let firstVerified: string[];
  let audits: { actorId?: string | null; action: string; targetType?: string; targetId?: string; payload?: object }[];
  let emails: { to: string; subject: string }[];
  let renderedTemplates: { name: string; vars: Record<string, unknown> }[];

  beforeEach(() => {
    current = {
      userId: "lawyer-1",
      country: "UK",
      verificationStatus: "PENDING",
      verificationNote: null,
      verifiedAt: null,
      qualifiedJurisdictions: ["England and Wales", "Scotland"],
      ph: NO_PH,
    };
    writes = [];
    audits = [];
    emails = [];
    renderedTemplates = [];

    restore = [
      stash(LawyerProfileRepo, ["find", "setVerification", "listForAdmin", "markFirstVerified"]),
      stash(AuthRepo, ["findById"]),
      stash(SecurityAuditSvc, ["record"]),
      stash(mailerModule as any, ["sendEmail"]),
      stash(templateModule as any, ["renderTemplate"]),
    ];

    (LawyerProfileRepo as any).find = async (userId: string) => (current && userId === current.userId ? { ...current } : null);
    (LawyerProfileRepo as any).setVerification = async (userId: string, data: any, confirmed?: string[]) => {
      writes.push({ userId, data, confirmed });
      current = { ...current!, ...data, ...(confirmed ? { qualifiedJurisdictions: confirmed } : {}) };
      return adminRow(current!);
    };
    firstVerified = [];
    (LawyerProfileRepo as any).markFirstVerified = async (userId: string) => void firstVerified.push(userId);
    (AuthRepo as any).findById = async (id: string) => (current && id === current.userId ? { id, name: "Jane Lawyer", email: "jane@example.com" } : null);
    (SecurityAuditSvc as any).record = async (data: any) => void audits.push(data);
    (mailerModule as any).sendEmail = async (opts: { to: string; subject: string }) => void emails.push(opts);
    (templateModule as any).renderTemplate = async (name: string, vars: Record<string, unknown>) => {
      renderedTemplates.push({ name, vars });
      return "<html></html>";
    };
  });

  afterEach(() => restore.forEach((r) => r()));

  describe("list", () => {
    it("maps each profile to an admin row, with the firm's details and no register check yet", async () => {
      let asked: unknown;
      (LawyerProfileRepo as any).listForAdmin = async (params: unknown) => {
        asked = params;
        return { data: [adminRow(current!), adminRow({ ...current!, userId: "lawyer-2" }, null)], total: 7 };
      };

      const { data, total } = await LawyerVerificationSvc.list({ country: "UK", status: "PENDING", page: 2, limit: 5 });

      expect(asked).to.deep.equal({ country: "UK", status: "PENDING", page: 2, limit: 5 });
      expect(total).to.equal(7);
      expect(data[0]).to.deep.include({
        userId: "lawyer-1",
        name: "Jane Lawyer",
        email: "jane@example.com",
        organizationName: "Jane & Co",
        registerCheck: null,
        submittedAt: SUBMITTED_AT,
      });
      expect(data[0].firm).to.deep.equal({
        name: "Jane & Co",
        regulator: "SRA",
        registrationNumber: "654321",
        phone: "020 7946 0000",
        address: { line1: "1 Fleet Street", line2: null, city: "London", postcode: "EC4Y 1AA" },
      });
      expect(data[0].profile.verification).to.deep.equal({ status: "PENDING", note: null, verifiedAt: null });
      expect(data[0].profile.registration).to.deep.equal({
        country: "UK",
        regulator: "SRA",
        registrationNumber: "123456",
        qualifiedJurisdictions: ["England and Wales", "Scotland"],
      });
      expect(data[0].profile.missing).to.deep.equal([]);
      expect(data[1].organizationName).to.equal(null);
      expect(data[1].firm).to.equal(null);
    });

    it("treats a solo practitioner's personal workspace as no firm", async () => {
      (LawyerProfileRepo as any).listForAdmin = async () => ({ data: [adminRow(current!, { name: "Personal workspace", isPersonal: true })], total: 1 });
      const { data } = await LawyerVerificationSvc.list({ country: "UK", status: "PENDING", page: 1, limit: 20 });
      expect(data[0].organizationName).to.equal(null);
      expect(data[0].firm).to.equal(null);
    });

    it("falls back to the email when the lawyer has no name", async () => {
      (LawyerProfileRepo as any).listForAdmin = async () => {
        const row = adminRow(current!);
        return { data: [{ ...row, user: { ...row.user, name: null } }], total: 1 };
      };
      const { data } = await LawyerVerificationSvc.list({ country: "UK", status: "PENDING", page: 1, limit: 20 });
      expect(data[0].name).to.equal("jane@example.com");
    });
  });

  describe("verify", () => {
    it("approves a PENDING UK application with the confirmed jurisdictions, audits it, and emails the lawyer", async () => {
      const result = await LawyerVerificationSvc.verify("lawyer-1", { confirmedJurisdictions: ["England and Wales"] }, "admin-1");

      expect(result.profile.verification.status).to.equal("VERIFIED");
      expect(result.profile.verification.note).to.equal(null);
      expect(result.profile.registration).to.include({ country: "UK" });
      expect((result.profile.registration as { qualifiedJurisdictions: string[] }).qualifiedJurisdictions).to.deep.equal(["England and Wales"]);
      expect(writes).to.have.length(1);
      expect(writes[0].data).to.include({ verificationStatus: "VERIFIED", verificationNote: null });
      expect(writes[0].confirmed).to.deep.equal(["England and Wales"]);
      expect(audits).to.deep.equal([
        {
          action: "admin.lawyer.verified",
          actorId: "admin-1",
          targetType: "user",
          targetId: "lawyer-1",
          payload: { from: "PENDING", to: "VERIFIED", confirmedJurisdictions: ["England and Wales"] },
        },
      ]);
      expect(emails.map(({ to, subject }) => ({ to, subject }))).to.deep.equal([
        { to: "jane@example.com", subject: "Your lawyer application has been approved" },
      ]);
      expect(renderedTemplates[0].name).to.equal("lawyer-verification-approved");
      expect(renderedTemplates[0].vars.nextStep).to.match(/Accept client requests/);
    });

    it("records the first verification, which lets a lawyer held by verify before plan in", async () => {
      await LawyerVerificationSvc.verify("lawyer-1", { confirmedJurisdictions: ["England and Wales"] }, "admin-1");
      expect(firstVerified).to.deep.equal(["lawyer-1"]);
    });

    it("needs at least one confirmed jurisdiction for a UK application", async () => {
      expect(await errorOf(LawyerVerificationSvc.verify("lawyer-1", {}, "admin-1"))).to.equal(400);
      expect(writes).to.have.length(0);
    });

    it("approves a PH application with no jurisdictions, and says what approval means there", async () => {
      current!.country = "PH";
      current!.ph = { ...NO_PH, rollNumber: "12345", ibpChapter: "Manila III" };
      const result = await LawyerVerificationSvc.verify("lawyer-1", { confirmedJurisdictions: ["Scotland"] }, "admin-1");

      expect(result.profile.registration).to.deep.equal({ country: "PH", ...NO_PH, rollNumber: "12345", ibpChapter: "Manila III" });
      expect(writes[0].confirmed).to.equal(undefined);
      expect(audits[0].payload).to.deep.equal({ from: "PENDING", to: "VERIFIED" });
      expect(renderedTemplates[0].vars.nextStep).to.match(/Approved badge/);
    });

    it("keeps the admin's note in the audit trail, not on the profile the lawyer sees", async () => {
      const result = await LawyerVerificationSvc.verify(
        "lawyer-1",
        { confirmedJurisdictions: ["Scotland"], note: "  Checked the LSS register by phone.  " },
        "admin-1"
      );

      expect(result.profile.verification.note).to.equal(null);
      expect(writes[0].data.verificationNote).to.equal(null);
      expect(audits[0].payload).to.deep.equal({
        from: "PENDING",
        to: "VERIFIED",
        confirmedJurisdictions: ["Scotland"],
        note: "Checked the LSS register by phone.",
      });
    });

    it("refuses to verify a profile that isn't PENDING (409), without writing", async () => {
      current!.verificationStatus = "VERIFIED";
      expect(await errorOf(LawyerVerificationSvc.verify("lawyer-1", { confirmedJurisdictions: ["England and Wales"] }, "admin-1"))).to.equal(409);
      expect(writes).to.have.length(0);
      expect(audits).to.have.length(0);
      expect(emails).to.have.length(0);
    });

    it("404s for an unknown profile", async () => {
      current = null;
      expect(await errorOf(LawyerVerificationSvc.verify("missing", { confirmedJurisdictions: ["England and Wales"] }, "admin-1"))).to.equal(404);
    });
  });

  describe("reject", () => {
    it("rejects a PENDING application with a canned reason, audits it, and emails the lawyer", async () => {
      const result = await LawyerVerificationSvc.reject("lawyer-1", "NAME_MISMATCH", undefined, "admin-1");

      expect(result.profile.verification).to.deep.equal({
        status: "REJECTED",
        note: "The name on your profile doesn't match the regulator's register.",
        verifiedAt: null,
      });
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
        { to: "jane@example.com", subject: "Your lawyer application wasn't approved" },
      ]);
      expect(renderedTemplates[0].vars.reason).to.equal("The name on your profile doesn't match the regulator's register.");
    });

    it("appends the admin's extra detail to a canned reason", async () => {
      const result = await LawyerVerificationSvc.reject("lawyer-1", "WRONG_JURISDICTION", "Register shows England only.", "admin-1");

      expect(result.profile.verification.note).to.equal(
        "The jurisdiction you selected doesn't match the regulator's register. Register shows England only."
      );
    });

    it("uses the admin's note verbatim for OTHER", async () => {
      const result = await LawyerVerificationSvc.reject("lawyer-1", "OTHER", "Submitted details are for a different person.", "admin-1");

      expect(result.profile.verification.note).to.equal("Submitted details are for a different person.");
    });

    it("uses the PH wording on a PH application, and refuses a UK-only reason there", async () => {
      current!.country = "PH";
      expect(await errorOf(LawyerVerificationSvc.reject("lawyer-1", "WRONG_JURISDICTION", undefined, "admin-1"))).to.equal(400);
      expect(writes).to.have.length(0);

      const result = await LawyerVerificationSvc.reject("lawyer-1", "ROLL_NOT_FOUND", undefined, "admin-1");
      expect(result.profile.verification.note).to.equal("We couldn't find your Roll of Attorneys number.");
    });

    it("refuses a PH-only reason on a UK application", async () => {
      expect(await errorOf(LawyerVerificationSvc.reject("lawyer-1", "NOT_IN_GOOD_STANDING", undefined, "admin-1"))).to.equal(400);
    });

    it("refuses to reject a profile that isn't PENDING (409), without writing", async () => {
      current!.verificationStatus = "REJECTED";
      expect(await errorOf(LawyerVerificationSvc.reject("lawyer-1", "NOT_PRACTISING", undefined, "admin-1"))).to.equal(409);
      expect(writes).to.have.length(0);
      expect(audits).to.have.length(0);
    });

    it("404s for an unknown profile", async () => {
      current = null;
      expect(await errorOf(LawyerVerificationSvc.reject("missing", "NAME_MISMATCH", undefined, "admin-1"))).to.equal(404);
    });
  });
});

describe("rejectLawyerSchema", () => {
  it("accepts a canned reason without a note, for either country", () => {
    expect(rejectLawyerSchema.validate({ reason: "NAME_MISMATCH" }).error).to.equal(undefined);
    expect(rejectLawyerSchema.validate({ reason: "ROLL_NOT_FOUND" }).error).to.equal(undefined);
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

describe("verifyLawyerSchema", () => {
  it("takes UK jurisdictions and an optional note, or just a note (PH)", () => {
    expect(verifyLawyerSchema.validate({ confirmedJurisdictions: ["England and Wales"] }).error).to.equal(undefined);
    expect(verifyLawyerSchema.validate({ confirmedJurisdictions: ["Scotland", "Northern Ireland"], note: "Checked" }).error).to.equal(undefined);
    expect(verifyLawyerSchema.validate({ note: "Checked the Roll" }).error).to.equal(undefined);
    expect(verifyLawyerSchema.validate({}).error).to.equal(undefined);
  });

  it("refuses an empty list, a non-UK jurisdiction and a repeat", () => {
    expect(verifyLawyerSchema.validate({ confirmedJurisdictions: [] }).error).to.exist;
    expect(verifyLawyerSchema.validate({ confirmedJurisdictions: ["Wales"] }).error).to.exist;
    expect(verifyLawyerSchema.validate({ confirmedJurisdictions: ["Scotland", "Scotland"] }).error).to.exist;
  });

  it("caps the note at 1000 characters", () => {
    expect(verifyLawyerSchema.validate({ confirmedJurisdictions: ["Scotland"], note: "x".repeat(1001) }).error).to.exist;
  });
});

describe("listLawyerVerificationsSchema", () => {
  it("defaults to the first page of UK PENDING", () => {
    expect(listLawyerVerificationsSchema.validate({}).value).to.deep.equal({ site: "UK", status: "PENDING", page: 1, limit: 20 });
  });

  it("converts query strings and rejects an unknown site or status", () => {
    const { error, value } = listLawyerVerificationsSchema.validate({ site: "PH", status: "REJECTED", page: "2", limit: "50" }, { convert: true });
    expect(error).to.equal(undefined);
    expect(value).to.deep.equal({ site: "PH", status: "REJECTED", page: 2, limit: 50 });
    expect(listLawyerVerificationsSchema.validate({ status: "APPROVED" }).error).to.exist;
    expect(listLawyerVerificationsSchema.validate({ site: "US" }).error).to.exist;
  });
});
