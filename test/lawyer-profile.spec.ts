/** A lawyer's client request profile (LawyerProfileSvc, /api/users/me/client-request-profile): UK
 * lawyers only, where verification goes after each edit, and when "accepting requests" may be on.
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

const complete = {
  regulator: "SRA",
  registrationNumber: "123456",
  qualifiedJurisdictions: ["England and Wales"],
  practiceAreas: ["EMPLOYMENT"],
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    userId: "u1",
    regulator: null,
    registrationNumber: null,
    qualifiedJurisdictions: [],
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
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as any;
}

describe("Lawyer client request profile", () => {
  describe("missingFields / nextVerificationStatus", () => {
    it("names what an admin needs before checking the register", () => {
      expect(missingFields(row())).to.deep.equal(["regulator", "registrationNumber", "qualifiedJurisdictions", "practiceAreas"]);
      expect(missingFields(row(complete))).to.deep.equal([]);
    });

    it("sends a newly complete profile to the admin queue", () => {
      expect(nextVerificationStatus(row(), row(complete))).to.equal("PENDING");
    });

    it("keeps a verified profile verified when only the bio or fee changes", () => {
      const verified = row({ ...complete, verificationStatus: "VERIFIED" });
      expect(nextVerificationStatus(verified, { ...verified, bio: "New bio", firstConsultationFeeMinor: 9000 })).to.equal("VERIFIED");
    });

    it("re-checks a verified or rejected profile when what was checked changes", () => {
      for (const status of ["VERIFIED", "REJECTED"]) {
        const before = row({ ...complete, verificationStatus: status });
        expect(nextVerificationStatus(before, { ...before, registrationNumber: "999999" }), status).to.equal("PENDING");
        expect(nextVerificationStatus(before, { ...before, qualifiedJurisdictions: ["Scotland"] }), status).to.equal("PENDING");
      }
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

    it("shows an empty, unsubmitted profile to a UK lawyer who hasn't filled it in", async () => {
      const dto = await LawyerProfileSvc.get("u1");
      expect(dto.verification.status).to.equal("UNSUBMITTED");
      expect(dto.missing).to.have.length(4);
      expect(dto.acceptingRequests).to.equal(false);
    });

    it("refuses a lawyer on another site, and a client account", async () => {
      who = { role: "LAWYER", tenantCode: "PH" };
      expect(await errorOf(LawyerProfileSvc.get("u1"))).to.deep.equal({ status: 403, code: "NOT_UK_TENANT" });
      who = { role: "USER", tenantCode: "UK" };
      expect(await errorOf(LawyerProfileSvc.update("u1", { bio: "x" }))).to.deep.equal({ status: 403, code: "NOT_A_LAWYER" });
    });

    it("saves the fee in pence and gives it back as GBP", async () => {
      const dto = await LawyerProfileSvc.update("u1", { ...complete, firstConsultationFee: { amountMinor: 15000, currency: "GBP" } });
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

    it("switches accepting off, rather than refusing the save, when a verified lawyer changes their number", async () => {
      stored = row({ ...complete, verificationStatus: "VERIFIED", verifiedAt: new Date(), acceptingRequests: true });
      const dto = await LawyerProfileSvc.update("u1", { registrationNumber: "654321" });
      expect(dto).to.include({ acceptingRequests: false });
      expect(dto.verification).to.deep.equal({ status: "PENDING", note: null, verifiedAt: null });
    });

    it("keeps pause and capacity", async () => {
      const until = new Date("2026-11-01T00:00:00Z");
      const dto = await LawyerProfileSvc.update("u1", { pausedUntil: until, capacityLimit: 3 });
      expect(dto).to.include({ pausedUntil: until, capacityLimit: 3 });
    });
  });

  describe("validation", () => {
    it("takes only UK jurisdictions, the client app's practice areas (no personal injury) and GBP", () => {
      expect(updateLawyerProfileSchema.validate(complete).error).to.equal(undefined);
      expect(updateLawyerProfileSchema.validate({ qualifiedJurisdictions: ["Wales"] }).error).to.not.equal(undefined);
      expect(updateLawyerProfileSchema.validate({ practiceAreas: ["PERSONAL_INJURY"] }).error).to.not.equal(undefined);
      expect(updateLawyerProfileSchema.validate({ firstConsultationFee: { amountMinor: 100, currency: "USD" } }).error).to.not.equal(undefined);
      expect(updateLawyerProfileSchema.validate({ capacityLimit: 0 }).error).to.not.equal(undefined);
    });
  });

  it("is served at /users/me/client-request-profile", () => {
    const routes = listRoutes(usersRoute).map((r) => `${r.method} ${r.path}`);
    expect(routes).to.include.members(["GET /me/client-request-profile", "PATCH /me/client-request-profile"]);
  });
});
