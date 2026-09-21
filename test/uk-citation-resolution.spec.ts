import { expect } from "chai";
import { describe, it } from "mocha";
import {
  extractActTitle,
  extractCaseUri,
  isLegislationResolution,
  isRealDocumentUrl,
  normalizeUkLegislationUrl,
} from "../src/utils/uk-citation-resolution";
import { UkResolvedCitation } from "../src/utils/uk-legal-mcp";

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

describe("normalizeUkLegislationUrl", () => {
  it("strips a section pinpoint down to the bare Act URL", () => {
    expect(normalizeUkLegislationUrl("https://www.legislation.gov.uk/ukpga/1967/87/section/1")).to.equal(
      "https://www.legislation.gov.uk/ukpga/1967/87",
    );
  });

  it("leaves an already-bare Act URL unchanged", () => {
    expect(normalizeUkLegislationUrl("https://www.legislation.gov.uk/ukpga/1967/87")).to.equal(
      "https://www.legislation.gov.uk/ukpga/1967/87",
    );
  });

  it("returns the input unchanged for a non-legislation.gov.uk URL", () => {
    expect(normalizeUkLegislationUrl("https://caselaw.nationalarchives.gov.uk/uksc/2022/34")).to.equal(
      "https://caselaw.nationalarchives.gov.uk/uksc/2022/34",
    );
  });
});

function resolvedCitation(overrides: Partial<UkResolvedCitation>): UkResolvedCitation {
  return {
    raw: "test",
    type: "unknown",
    year: null,
    court: null,
    number: null,
    report_series: null,
    volume: null,
    page: null,
    legislation_title: null,
    section: null,
    si_year: null,
    si_number: null,
    resolved_url: null,
    confidence: 1,
    ...overrides,
  };
}

describe("isLegislationResolution", () => {
  it("is true when the MCP populated legislation_title", () => {
    expect(isLegislationResolution(resolvedCitation({ legislation_title: "Abortion Act 1967" }))).to.equal(true);
  });

  it("is true when the MCP populated section (an Act pinpoint)", () => {
    expect(isLegislationResolution(resolvedCitation({ section: "1" }))).to.equal(true);
  });

  it("is true when the MCP populated si_number (a statutory instrument)", () => {
    expect(isLegislationResolution(resolvedCitation({ si_number: 123 }))).to.equal(true);
  });

  it("is false for a plain case citation with none of the legislation-only fields set", () => {
    expect(isLegislationResolution(resolvedCitation({ court: "UKSC", number: 34 }))).to.equal(false);
  });
});

describe("isRealDocumentUrl", () => {
  it("is false when there is no resolved_url at all", () => {
    expect(isRealDocumentUrl(resolvedCitation({ resolved_url: null }))).to.equal(false);
  });

  it("is true for a real /type/year/number legislation URL", () => {
    expect(
      isRealDocumentUrl(
        resolvedCitation({ section: "1", resolved_url: "https://www.legislation.gov.uk/uksi/2020/503" }),
      ),
    ).to.equal(true);
  });

  // Regression: citations_resolve can recognize a legislation citation's grammar but fail to
  // pin down the exact document, returning a generic search-results URL instead of a real one
  // (observed live: "s.1 Abortion Act 1967" -> confidence 0.95 ->
  // "https://www.legislation.gov.uk/search?title=Abortion+Act+1967"). Without this guard,
  // resolveUkCitationToLaw would materialize a permanent Library entry pointing at a search
  // page rather than the Act actually cited.
  it("is false for a legislation resolution whose resolved_url is a search-results page, not a document", () => {
    expect(
      isRealDocumentUrl(
        resolvedCitation({
          legislation_title: "Abortion Act 1967",
          section: "1",
          resolved_url: "https://www.legislation.gov.uk/search?title=Abortion+Act+1967",
        }),
      ),
    ).to.equal(false);
  });

  it("is true for a real TNA case URL", () => {
    expect(
      isRealDocumentUrl(
        resolvedCitation({ court: "UKSC", resolved_url: "https://caselaw.nationalarchives.gov.uk/uksc/2018/27" }),
      ),
    ).to.equal(true);
  });

  it("is false for a case resolution whose resolved_url isn't a TNA case URL", () => {
    expect(
      isRealDocumentUrl(
        resolvedCitation({ court: "UKSC", resolved_url: "https://www.legislation.gov.uk/search?title=Foo" }),
      ),
    ).to.equal(false);
  });
});

describe("extractActTitle", () => {
  it("strips a section pinpoint, cutting right after the enactment year", () => {
    expect(extractActTitle("Protection from Eviction Act 1977, s 3")).to.equal("Protection from Eviction Act 1977");
    expect(extractActTitle("Abortion Act 1967, s 1")).to.equal("Abortion Act 1967");
  });

  it("leaves a label with no trailing pinpoint unchanged", () => {
    expect(extractActTitle("The Abortion (Northern Ireland) (No. 2) Regulations 2020")).to.equal(
      "The Abortion (Northern Ireland) (No. 2) Regulations 2020",
    );
  });

  it("strips a schedule pinpoint the same way", () => {
    expect(extractActTitle("Companies Act 2006, Sch 2")).to.equal("Companies Act 2006");
  });

  it("returns the input unchanged when it has no 4-digit year at all", () => {
    expect(extractActTitle("some unparseable label")).to.equal("some unparseable label");
  });
});
