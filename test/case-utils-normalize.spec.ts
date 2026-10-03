import { expect } from "chai";
import { describe, it } from "mocha";
import { normalizeCaseBody } from "../src/utils/case.utils";

describe("normalizeCaseBody", () => {
  it("splits a multi-party partyInvolved string into one party per entry", () => {
    const result = normalizeCaseBody({
      caseName: "X",
      partyInvolved: "Jane Smith (Petitioner / Plaintiff); Acme Ltd (Respondent / Defendant); Bob Jones (Intervenor / Third-Party)",
    });
    expect(result.parties).to.deep.equal([
      { name: "Jane Smith", designation: "Petitioner / Plaintiff" },
      { name: "Acme Ltd", designation: "Respondent / Defendant" },
      { name: "Bob Jones", designation: "Intervenor / Third-Party" },
    ]);
  });

  it("gives a bare name the default designation and skips empty entries", () => {
    const result = normalizeCaseBody({ partyInvolved: "Jane Smith; ;" });
    expect(result.parties).to.deep.equal([{ name: "Jane Smith", designation: "Petitioner / Plaintiff" }]);
  });

  it("leaves an explicit parties array alone", () => {
    const parties = [{ name: "A", designation: "Respondent / Defendant" }];
    const result = normalizeCaseBody({ parties, partyInvolved: "B (Petitioner / Plaintiff)" });
    expect(result.parties).to.equal(parties);
  });
});
