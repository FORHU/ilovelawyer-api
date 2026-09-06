import { expect } from "chai";
import { describe, it } from "mocha";
import { extractCaseUri } from "../src/utils/uk-citation-resolution";

describe("extractCaseUri", () => {
  it("extracts the TNA slug from a resolved case URL", () => {
    expect(extractCaseUri("https://caselaw.nationalarchives.gov.uk/uksc/2022/34")).to.equal("uksc/2022/34");
    expect(extractCaseUri("https://caselaw.nationalarchives.gov.uk/ewhc/ch/2026/2266")).to.equal("ewhc/ch/2026/2266");
  });

  it("strips a trailing slash", () => {
    expect(extractCaseUri("https://caselaw.nationalarchives.gov.uk/uksc/2022/34/")).to.equal("uksc/2022/34");
  });

  it("returns null for a legislation.gov.uk URL — not a judgment, nothing to expand", () => {
    expect(extractCaseUri("https://www.legislation.gov.uk/ukpga/2015/15/section/1")).to.equal(null);
  });

  it("returns null when there is no URL at all", () => {
    expect(extractCaseUri(null)).to.equal(null);
    expect(extractCaseUri(undefined)).to.equal(null);
    expect(extractCaseUri("")).to.equal(null);
  });
});
