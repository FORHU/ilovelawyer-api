/** A lawyer's Lawyer Application (LawyerProfileSvc, /api/users/me/client-request-profile): UK and
 * PH lawyers, where verification goes after each edit, and when "accepting requests" may be on.
 * No live Postgres: the repository is monkeypatched, same idiom as test/client-case.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import LawyerProfileSvc, { missingFields, nextVerificationStatus } from "../src/services/lawyer-profile.service";
import LawyerProfileRepo from "../src/repositories/lawyer-profile.repository";
import usersRoute from "../src/routes/users.route";
import { updateLawyerProfileSchema } from "../src/validation/lawyer-profile.validation";
import { listRoutes } from "./support/list-routes";

async function errorOf(promise: Promise<unknown>): Promise<{ status?: number; code?: string; missing?: unknown } | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err: any) {
    return { status: err.statusCode, code: err.code, ...(err.details?.missing ? { missing: err.details.missing } : {}) };
  }
}

/** A complete UK registration, as the repository flattens it onto the row. */
const ukRegistration = { regulator: "SRA", registrationNumber: "123456", qualifiedJurisdictions: ["England and Wales"] };
const complete = { ...ukRegistration, practiceAreas: ["EMPLOYMENT"] };
/** The same, as a lawyer sends it. */
const completePatch = { registration: { country: "UK" as const, ...ukRegistration }, practiceAreas: ["EMPLOYMENT"] };

const noPh = { rollNumber: null, ibpChapter: null, ibpMembershipNumber: null, mcleNumber: null, mclePeriod: null };

function row(overrides: Record<string, unknown> = {}) {
  return {
    userId: "u1",
    country: "UK",
    regulator: null,
    registrationNumber: null,
    qualifiedJurisdictions: [],
    ph: noPh,
    practiceAreas: [],
    bio: "",
    languages: [],
    firstConsultationFeeMinor: null,
    acceptingRequests: false,
    enabledByOrganization: true,
    pausedUntil: null,
    capacityLimit: null,
    verificationStatus: "UNSUBMITTED",
    verificationNote: null,
    verifiedAt: null,
    submittedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as any;
}

describe("Lawyer Application", () => {
  describe("missingFields / nextVerificationStatus", () => {
    it("names what an admin needs before checking the register (UK)", () => {
      expect(missingFields(row())).to.deep.equal(["regulator", "registrationNumber", "qualifiedJurisdictions", "practiceAreas"]);
      expect(missingFields(row(complete))).to.deep.equal([]);
    });

    it("needs the Roll number, IBP chapter and a practice area on PH, and nothing optional", () => {
      expect(missingFields(row({ country: "PH" }))).to.deep.equal(["rollNumber", "ibpChapter", "practiceAreas"]);
      expect(missingFields(row({ country: "PH", ph: { ...noPh, rollNumber: "12345", ibpChapter: "Manila III" }, practiceAreas: ["CIVIL"] }))).to.deep.equal([]);
    });

    it("sends a newly complete profile to the admin queue", () => {
      expect(nextVerificationStatus(row(), row(complete))).to.equal("PENDING");
    });

    it("keeps a verified profile verified when only the bio or fee changes", () => {
      const verified = row({ ...complete, verificationStatus: "VERIFIED" });
      expect(nextVerificationStatus(verified, { ...verified, bio: "New bio", firstConsultationFeeMinor: 9000 })).to.equal("VERIFIED");
    });

    it("re-checks a verified or rejected UK profile when what was checked changes", () => {
      for (const status of ["VERIFIED", "REJECTED"]) {
        const before = row({ ...complete, verificationStatus: status });
        expect(nextVerificationStatus(before, { ...before, registrationNumber: "999999" }), status).to.equal("PENDING");
        expect(nextVerificationStatus(before, { ...before, qualifiedJurisdictions: ["Scotland"] }), status).to.equal("PENDING");
      }
    });

    it("re-checks a PH profile on the Roll number or IBP chapter, not on MCLE or membership", () => {
      const ph = { ...noPh, rollNumber: "12345", ibpChapter: "Manila III" };
      const before = row({ country: "PH", ph, practiceAreas: ["CIVIL"], verificationStatus: "VERIFIED" });
      expect(nextVerificationStatus(before, { ...before, ph: { ...ph, rollNumber: "54321" } })).to.equal("PENDING");
      expect(nextVerificationStatus(before, { ...before, ph: { ...ph, ibpChapter: "Cebu City" } })).to.equal("PENDING");
      expect(nextVerificationStatus(before, { ...before, ph: { ...ph, mcleNumber: "VII-0001", ibpMembershipNumber: "L-1" } })).to.equal("VERIFIED");
    });

    it("drops back to unsubmitted when a required field is cleared", () => {
      const verified = row({ ...complete, verificationStatus: "VERIFIED" });
      expect(nextVerificationStatus(verified, { ...verified, practiceAreas: [] })).to.equal("UNSUBMITTED");
    });
  });

  describe("LawyerProfileSvc", () => {
    const original = { find: LawyerProfileRepo.find, upsert: LawyerProfileRepo.upsert, findLawyerTenant: LawyerProfileRepo.findLawyerTenant };
    let stored: any;
    let who: { role: string; tenantCode: string | null } | null;

    beforeEach(() => {
      stored = null;
      who = { role: "LAWYER", tenantCode: "UK" };
      (LawyerProfileRepo as any).find = async () => stored;
      (LawyerProfileRepo as any).upsert = async (_userId: string, data: any) => (stored = { userId: "u1", ...data });
      (LawyerProfileRepo as any).findLawyerTenant = async () => who;
    });
    afterEach(() => Object.assign(LawyerProfileRepo, original));

    it("shows an empty, unsubmitted UK application to a UK lawyer who hasn't filled it in", async () => {
      const dto = await LawyerProfileSvc.get("u1");
      expect(dto.country).to.equal("UK");
      expect(dto.registration).to.deep.equal({ country: "UK", regulator: null, registrationNumber: null, qualifiedJurisdictions: [] });
      expect(dto.verification.status).to.equal("UNSUBMITTED");
      expect(dto.missing).to.have.length(4);
      expect(dto.acceptingRequests).to.equal(false);
    });

    it("gives a PH lawyer a PH application, in pesos", async () => {
      who = { role: "LAWYER", tenantCode: "PH" };
      expect((await LawyerProfileSvc.get("u1")).registration).to.deep.equal({ country: "PH", ...noPh });

      const dto = await LawyerProfileSvc.update("u1", {
        registration: { country: "PH", rollNumber: "12345", ibpChapter: "Manila III" },
        practiceAreas: ["CIVIL"],
        firstConsultationFee: { amountMinor: 150000, currency: "PHP" },
      });
      expect(stored.country).to.equal("PH");
      expect(stored.ph).to.include({ rollNumber: "12345", ibpChapter: "Manila III" });
      expect(dto.verification.status).to.equal("PENDING");
      expect(dto.firstConsultationFee).to.deep.equal({ amountMinor: 150000, currency: "PHP" });
    });

    it("refuses registration details for the other country", async () => {
      who = { role: "LAWYER", tenantCode: "PH" };
      expect(await errorOf(LawyerProfileSvc.update("u1", completePatch))).to.deep.equal({ status: 400, code: "WRONG_COUNTRY" });
    });

    it("refuses a lawyer on a site without applications, and a client account", async () => {
      who = { role: "LAWYER", tenantCode: null };
      expect(await errorOf(LawyerProfileSvc.get("u1"))).to.deep.equal({ status: 403, code: "NOT_SUPPORTED_TENANT" });
      who = { role: "USER", tenantCode: "UK" };
      expect(await errorOf(LawyerProfileSvc.update("u1", { bio: "x" }))).to.deep.equal({ status: 403, code: "NOT_A_LAWYER" });
    });

    it("saves the fee in pence and gives it back as GBP", async () => {
      const dto = await LawyerProfileSvc.update("u1", { ...completePatch, firstConsultationFee: { amountMinor: 15000, currency: "GBP" } });
      expect(stored.firstConsultationFeeMinor).to.equal(15000);
      expect(dto.firstConsultationFee).to.deep.equal({ amountMinor: 15000, currency: "GBP" });
      expect(dto.verification.status).to.equal("PENDING");
    });

    it("won't switch on accepting requests until the profile is complete, then verified", async () => {
      expect(await errorOf(LawyerProfileSvc.update("u1", { acceptingRequests: true }))).to.deep.equal({
        status: 422,
        code: "PROFILE_INCOMPLETE",
        missing: ["regulator", "registrationNumber", "qualifiedJurisdictions", "practiceAreas"],
      });
      stored = row({ ...complete, verificationStatus: "PENDING" });
      expect(await errorOf(LawyerProfileSvc.update("u1", { acceptingRequests: true }))).to.deep.equal({ status: 403, code: "LAWYER_NOT_VERIFIED" });
      stored = row({ ...complete, verificationStatus: "VERIFIED", verifiedAt: new Date() });
      expect((await LawyerProfileSvc.update("u1", { acceptingRequests: true })).acceptingRequests).to.equal(true);
    });

    it("never lets a PH lawyer accept client requests (UK only)", async () => {
      who = { role: "LAWYER", tenantCode: "PH" };
      stored = row({ country: "PH", ph: { ...noPh, rollNumber: "1", ibpChapter: "Manila III" }, practiceAreas: ["CIVIL"], verificationStatus: "VERIFIED" });
      expect(await errorOf(LawyerProfileSvc.update("u1", { acceptingRequests: true }))).to.deep.equal({ status: 403, code: "NOT_UK_TENANT" });
    });

    it("switches accepting off, rather than refusing the save, when a verified lawyer changes their number", async () => {
      stored = row({ ...complete, verificationStatus: "VERIFIED", verifiedAt: new Date(), acceptingRequests: true });
      const dto = await LawyerProfileSvc.update("u1", { registration: { country: "UK", registrationNumber: "654321" } });
      expect(dto).to.include({ acceptingRequests: false });
      expect(dto.verification).to.deep.equal({ status: "PENDING", note: null, verifiedAt: null });
    });

    it("dates the submission when the profile joins the admin queue, and again on a resubmission", async () => {
      await LawyerProfileSvc.update("u1", { bio: "Draft" });
      expect(stored.submittedAt).to.equal(null);

      await LawyerProfileSvc.update("u1", completePatch);
      expect(stored.verificationStatus).to.equal("PENDING");
      expect(stored.submittedAt).to.be.instanceOf(Date);

      const first = new Date("2026-10-01T00:00:00Z");
      stored = row({ ...complete, verificationStatus: "REJECTED", verificationNote: "Wrong number", submittedAt: first });
      await LawyerProfileSvc.update("u1", { registration: { country: "UK", registrationNumber: "654321" } });
      expect(stored.verificationStatus).to.equal("PENDING");
      expect(stored.submittedAt.getTime()).to.be.greaterThan(first.getTime());
    });

    it("keeps the submission date when an edit doesn't change the status", async () => {
      const first = new Date("2026-10-01T00:00:00Z");
      for (const status of ["PENDING", "VERIFIED"]) {
        stored = row({ ...complete, verificationStatus: status, verifiedAt: status === "VERIFIED" ? new Date() : null, submittedAt: first });
        await LawyerProfileSvc.update("u1", { bio: "New bio" });
        expect(stored.verificationStatus, status).to.equal(status);
        expect(stored.submittedAt, status).to.equal(first);
      }
    });

    it("keeps the country a lawyer applied in, even if their site later changes", async () => {
      stored = row({ ...complete, country: "UK" });
      who = { role: "LAWYER", tenantCode: "PH" };
      expect((await LawyerProfileSvc.get("u1")).country).to.equal("UK");
    });

    it("keeps pause and capacity", async () => {
      const until = new Date("2026-11-01T00:00:00Z");
      const dto = await LawyerProfileSvc.update("u1", { pausedUntil: until, capacityLimit: 3 });
      expect(dto).to.include({ pausedUntil: until, capacityLimit: 3 });
    });
  });

  describe("validation", () => {
    it("UK: takes only UK jurisdictions, the client app's practice areas (no personal injury) and GBP", () => {
      const uk = updateLawyerProfileSchema("UK");
      expect(uk.validate(completePatch).error).to.equal(undefined);
      expect(uk.validate({ registration: { country: "UK", qualifiedJurisdictions: ["Wales"] } }).error).to.not.equal(undefined);
      expect(uk.validate({ practiceAreas: ["PERSONAL_INJURY"] }).error).to.not.equal(undefined);
      expect(uk.validate({ firstConsultationFee: { amountMinor: 100, currency: "PHP" } }).error).to.not.equal(undefined);
      expect(uk.validate({ capacityLimit: 0 }).error).to.not.equal(undefined);
      expect(uk.validate({ registration: { country: "PH", rollNumber: "1" } }).error).to.not.equal(undefined);
    });

    it("PH: takes the PH registration, PH practice areas and pesos", () => {
      const ph = updateLawyerProfileSchema("PH");
      expect(ph.validate({ registration: { country: "PH", rollNumber: "12345", ibpChapter: "Manila III", mclePeriod: "VII" }, practiceAreas: ["LABOR"] }).error).to.equal(undefined);
      expect(ph.validate({ practiceAreas: ["EMPLOYMENT"] }).error).to.not.equal(undefined);
      expect(ph.validate({ firstConsultationFee: { amountMinor: 100, currency: "GBP" } }).error).to.not.equal(undefined);
      expect(ph.validate({ registration: { country: "UK", regulator: "SRA" } }).error).to.not.equal(undefined);
    });
  });

  it("is served at /users/me/client-request-profile", () => {
    const routes = listRoutes(usersRoute).map((r) => `${r.method} ${r.path}`);
    expect(routes).to.include.members(["GET /me/client-request-profile", "PATCH /me/client-request-profile", "POST /me/setup/complete"]);
  });
});
