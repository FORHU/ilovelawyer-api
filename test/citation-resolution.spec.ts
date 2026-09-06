import { expect } from "chai";
import { describe, it } from "mocha";
import { pickBestMatch } from "../src/utils/citation-resolution";

describe("pickBestMatch", () => {
  it("returns null when there are no candidates", () => {
    expect(pickBestMatch([], { caseNumber: "G.R. No. 179936" })).to.equal(null);
  });

  it("prefers an exact case-number match over the search's own ordering", () => {
    const candidates = [
      { stored_id: "wrong", case_number: "G.R. No. 000000" },
      { stored_id: "right", case_number: "G.R. No. 179936" },
    ];
    const result = pickBestMatch(candidates, { caseNumber: "G.R. No. 179936" });
    expect(result).to.deep.equal({ lawId: "right", confidence: 0.95 });
  });

  it("matches case numbers regardless of whitespace differences", () => {
    const candidates = [{ stored_id: "right", case_number: "G.R.  No.   179936" }];
    const result = pickBestMatch(candidates, { caseNumber: "G.R. No. 179936" });
    expect(result?.lawId).to.equal("right");
  });

  it("falls back to the top result with a year-match confidence when years agree", () => {
    const candidates = [{ stored_id: "top", case_number: "G.R. No. 999999", year: 2019 }];
    const result = pickBestMatch(candidates, { title: "People v. Santos", year: 2019 });
    expect(result).to.deep.equal({ lawId: "top", confidence: 0.6 });
  });

  it("falls back to the top result with a lower confidence when there is no year to check", () => {
    const candidates = [{ stored_id: "top", case_number: "G.R. No. 999999" }];
    const result = pickBestMatch(candidates, { title: "People v. Santos" });
    expect(result).to.deep.equal({ lawId: "top", confidence: 0.35 });
  });

  it("does not let a mismatched year silently upgrade confidence", () => {
    const candidates = [{ stored_id: "top", case_number: "G.R. No. 999999", year: 2010 }];
    const result = pickBestMatch(candidates, { title: "People v. Santos", year: 2019 });
    expect(result).to.deep.equal({ lawId: "top", confidence: 0.35 });
  });
});
