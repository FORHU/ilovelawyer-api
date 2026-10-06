import { expect } from "chai";
import { describe, it } from "mocha";
import { createCaseSchema } from "../src/validation/case.validation";
import { normalizeCaseBody } from "../src/utils/case.utils";

const base = { caseName: "R v Brandon", parties: [{ name: "Sheila Brandon", designation: "Respondent / Defendant" }] };

describe("case creation client side", () => {
  it("keeps the side the lawyer acts for through validation and normalisation", () => {
    const { error, value } = createCaseSchema.validate({ ...base, clientSide: "RESPONDENT" });
    expect(error).to.equal(undefined);
    expect(normalizeCaseBody(value)).to.include({ clientSide: "RESPONDENT" });
  });

  it("keeps it when parties arrive as the legacy partyInvolved string", () => {
    const { value } = createCaseSchema.validate({ caseName: "R v Brandon", partyInvolved: "Crown (Petitioner / Plaintiff)", clientSide: "CLAIMANT" });
    expect(normalizeCaseBody(value)).to.include({ clientSide: "CLAIMANT" });
  });

  it("lets a case be created without choosing a side", () => {
    expect(createCaseSchema.validate(base).error).to.equal(undefined);
    expect(createCaseSchema.validate({ ...base, clientSide: null }).error).to.equal(undefined);
  });

  it("rejects a side that isn't claimant or respondent", () => {
    expect(createCaseSchema.validate({ ...base, clientSide: "INTERVENOR" }).error).to.not.equal(undefined);
  });
});
