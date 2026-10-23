/** What a firm's details and a Lawyer Application's fields may hold (constants/field-rules.ts): the
 * lawyer app filters the same characters as they're typed, and these are the API's own checks. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, after } from "mocha";
import prisma from "../src/lib/prisma";
import OrganizationSvc from "../src/services/organization.service";
import { createOrganizationSchema } from "../src/validation/organization.validation";
import { updateLawyerProfileSchema } from "../src/validation/lawyer-profile.validation";

const firm = (details: object) => createOrganizationSchema.validate({ name: "Rules LLP", ...details });
const uk = (registration: object) => updateLawyerProfileSchema("UK").validate({ registration: { country: "UK", ...registration } });
const ph = (registration: object) => updateLawyerProfileSchema("PH").validate({ registration: { country: "PH", ...registration } });

describe("field rules", () => {
  describe("a firm's details", () => {
    it("takes a phone number of digits and spaces, with an optional +", () => {
      expect(firm({ phone: "+44 20 7946 0958" }).error).to.equal(undefined);
      expect(firm({ phone: "0917 123 4567" }).error).to.equal(undefined);
      expect(firm({ phone: "" }).error).to.equal(undefined);
      expect(firm({ phone: "call me" }).error).to.not.equal(undefined);
      expect(firm({ phone: "0917-ABC" }).error).to.not.equal(undefined);
      expect(firm({ phone: "123" }).error).to.not.equal(undefined);
      expect(firm({ phone: "1234567890123456" }).error).to.not.equal(undefined);
    });

    it("takes a firm number of digits and a city of letters", () => {
      expect(firm({ firmRegistrationNumber: "612345", city: "Stoke-on-Trent" }).error).to.equal(undefined);
      expect(firm({ firmRegistrationNumber: "SRA612345" }).error).to.not.equal(undefined);
      expect(firm({ city: "Manila 1000" }).error).to.not.equal(undefined);
    });
  });

  describe("a firm's postcode, for its site", () => {
    const createdUserIds: string[] = [];
    after(async () => {
      await prisma.organizationMember.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.organization.deleteMany({ where: { createdById: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    });
    const owner = async () => {
      const id = crypto.randomUUID();
      createdUserIds.push(id);
      await prisma.user.create({ data: { id, email: `rules-${id}@example.com`, username: `rules-${id}` } });
      return id;
    };

    it("is a UK postcode on UK and a 4-digit ZIP code on PH", async () => {
      expect((await OrganizationSvc.create(await owner(), "UK Rules", undefined, "UK", false, { postcode: "SW1A 1AA" })).postcode).to.equal("SW1A 1AA");
      expect((await OrganizationSvc.create(await owner(), "PH Rules", undefined, "PH", false, { postcode: "1000" })).postcode).to.equal("1000");
      const ukErr = await OrganizationSvc.create(await owner(), "UK Bad", undefined, "UK", false, { postcode: "1000" }).catch((e) => e);
      expect(ukErr.code).to.equal("INVALID_POSTCODE");
      const phErr = await OrganizationSvc.create(await owner(), "PH Bad", undefined, "PH", false, { postcode: "SW1A 1AA" }).catch((e) => e);
      expect(phErr.code).to.equal("INVALID_POSTCODE");
    });
  });

  describe("a Lawyer Application", () => {
    it("takes UK registration numbers of digits only", () => {
      expect(uk({ registrationNumber: "612345" }).error).to.equal(undefined);
      expect(uk({ registrationNumber: "SRA-612345" }).error).to.not.equal(undefined);
      expect(uk({ registrationNumber: "12345678901" }).error).to.not.equal(undefined);
    });

    it("takes PH numbers of digits, a chapter of letters, an MCLE number and a Roman-numeral period", () => {
      expect(ph({ rollNumber: "65432", ibpChapter: "Manila III", ibpMembershipNumber: "1234567", mcleNumber: "VII-0012345", mclePeriod: "VII" }).error).to.equal(undefined);
      expect(ph({ rollNumber: "Roll 65432" }).error).to.not.equal(undefined);
      expect(ph({ ibpChapter: "Manila 3" }).error).to.not.equal(undefined);
      expect(ph({ ibpMembershipNumber: "OR-123" }).error).to.not.equal(undefined);
      expect(ph({ mcleNumber: "VII/0012345" }).error).to.not.equal(undefined);
      expect(ph({ mclePeriod: "2022" }).error).to.not.equal(undefined);
    });

    it("takes languages of letters", () => {
      expect(updateLawyerProfileSchema("UK").validate({ languages: ["English", "British Sign Language"] }).error).to.equal(undefined);
      expect(updateLawyerProfileSchema("UK").validate({ languages: ["English 2"] }).error).to.not.equal(undefined);
    });
  });
});
