import { expect } from "chai";
import { describe, it } from "mocha";
import {
  CASE_NAME_MAX_LENGTH,
  PARTY_NAME_MAX_LENGTH,
  createCaseSchema,
  updateCaseSchema,
} from "../src/validation/case.validation";
import { normalizeCaseBody } from "../src/utils/case.utils";

const party = (name: string) => ({ name, designation: "Petitioner / Plaintiff" });

describe("case title and party name limits", () => {
  it("accepts a title and party name right at the limit", () => {
    const { error } = createCaseSchema.validate({
      caseName: "a".repeat(CASE_NAME_MAX_LENGTH),
      parties: [party("b".repeat(PARTY_NAME_MAX_LENGTH))],
    });
    expect(error).to.equal(undefined);
  });

  it("rejects a title over the limit on create and update", () => {
    const caseName = "a".repeat(CASE_NAME_MAX_LENGTH + 1);
    expect(createCaseSchema.validate({ caseName }).error?.message).to.match(/Case title/);
    expect(updateCaseSchema.validate({ caseName }).error?.message).to.match(/Case title/);
  });

  it("rejects a party name over the limit", () => {
    const parties = [party("b".repeat(PARTY_NAME_MAX_LENGTH + 1))];
    expect(createCaseSchema.validate({ caseName: "R v Brandon", parties }).error?.message).to.match(/Party name/);
    expect(updateCaseSchema.validate({ parties }).error?.message).to.match(/Party name/);
  });

  it("rejects an over-long party sent as the legacy partyInvolved string", () => {
    const { value } = createCaseSchema.validate({ caseName: "R v Brandon", partyInvolved: "c".repeat(PARTY_NAME_MAX_LENGTH + 1) });
    expect(() => normalizeCaseBody(value)).to.throw(/Party name/);
  });

  it("measures the trimmed value, so surrounding whitespace doesn't count", () => {
    const { error, value } = createCaseSchema.validate({ caseName: `  ${"a".repeat(CASE_NAME_MAX_LENGTH)}  ` });
    expect(error).to.equal(undefined);
    expect(value.caseName).to.have.length(CASE_NAME_MAX_LENGTH);
  });
});
