import { expect } from "chai";
import { describe, it } from "mocha";
import { isKnownLawHost, rewriteLegalCitationLinks, stripCitationSuffix } from "../src/utils/legal-citation-link-rewrite";

describe("stripCitationSuffix", () => {
  it("strips a trailing ' Law' suffix", () => {
    expect(stripCitationSuffix("Abortion Act 1967, s 1 Law")).to.equal("Abortion Act 1967, s 1");
  });

  it("strips a trailing ' Jurisprudence' suffix, case-insensitively", () => {
    expect(stripCitationSuffix("Manalo jurisprudence")).to.equal("Manalo");
  });

  it("leaves a label with no recognized suffix unchanged", () => {
    expect(stripCitationSuffix("Abortion Act 1967, s 1")).to.equal("Abortion Act 1967, s 1");
  });
});

describe("isKnownLawHost", () => {
  it("accepts legislation.gov.uk and caselaw.nationalarchives.gov.uk for a UK tenant", () => {
    expect(isKnownLawHost("https://www.legislation.gov.uk/ukpga/1967/87/section/1", "UK")).to.equal(true);
    expect(isKnownLawHost("https://caselaw.nationalarchives.gov.uk/uksc/2018/27", "UK")).to.equal(true);
  });

  it("rejects an unrelated host for a UK tenant", () => {
    expect(isKnownLawHost("https://hansard.parliament.uk/commons/2020", "UK")).to.equal(false);
  });

  it("accepts juris.ph for a PH tenant", () => {
    expect(isKnownLawHost("https://juris.ph/case/abc123", "PH")).to.equal(true);
  });

  it("rejects an unrelated host for a PH tenant", () => {
    expect(isKnownLawHost("https://www.legislation.gov.uk/ukpga/1967/87", "PH")).to.equal(false);
  });

  it("rejects an unparseable href without throwing", () => {
    expect(isKnownLawHost("not a url", "PH")).to.equal(false);
  });

  // Regression: a real citation URL that differs from the configured base only by "www.",
  // scheme, or case was previously rejected by a raw href.startsWith(BASE_URL) check — which
  // looks identical to "not a Library-backed host at all" and silently falls back to the
  // external link even for a document that's genuinely already in the Library (e.g. "The
  // Abortion (Northern Ireland) (No. 2) Regulations 2020", found manually in the Library but
  // never rewritten from chat). Hostname comparison must tolerate these variations.
  it("accepts a legislation.gov.uk URL that differs from the configured base by 'www.'", () => {
    expect(isKnownLawHost("https://legislation.gov.uk/nisr/2020/149/made", "UK")).to.equal(true);
  });

  it("accepts a caselaw.nationalarchives.gov.uk URL regardless of scheme/case differences", () => {
    expect(isKnownLawHost("HTTPS://CASELAW.NATIONALARCHIVES.GOV.UK/uksc/2018/27", "UK")).to.equal(true);
  });
});

describe("rewriteLegalCitationLinks", () => {
  it("returns content unchanged when there are no links at all", async () => {
    const content = "No citations here.";
    const result = await rewriteLegalCitationLinks(content, "UK");
    expect(result).to.deep.equal({ content, rewrittenCount: 0, attemptedCount: 0, strippedCount: 0 });
  });

  // No-external-navigation policy: a citation that can't be Library-backed at all (wrong host)
  // must not stay as a clickable external link — it's stripped down to plain text instead, with
  // zero resolution attempts (there's no chance a Hansard URL matches a Library item).
  it("strips a plain-markdown citation to an unrecognized host down to plain text", async () => {
    const content = "See [Hansard debate Law](https://hansard.parliament.uk/commons/2020).";
    const result = await rewriteLegalCitationLinks(content, "UK");
    expect(result).to.deep.equal({
      content: "See Hansard debate Law.",
      rewrittenCount: 0,
      attemptedCount: 0,
      strippedCount: 1,
    });
  });

  // Real citations arrive in this HTML-anchor form, not plain markdown — chat-wonder-v2-api's
  // format_legal_citation_links (legal_citations.py) converts every `[<label> Law/Jurisprudence]
  // (url)` markdown link into `<a href="url" class="legal-ref ..." target="_blank">label</a>`
  // before ilovelawyer-api ever sees it. This must be recognized as a citation candidate (and
  // stripped here since the host isn't a known law host) or every real citation would silently
  // never be attempted.
  it("strips an HTML-anchor citation to an unrecognized host down to plain text", async () => {
    const content =
      'See <a href="https://hansard.parliament.uk/commons/2020" class="legal-ref law" target="_blank">' +
      "Some Debate Law</a>.";
    const result = await rewriteLegalCitationLinks(content, "UK");
    expect(result).to.deep.equal({
      content: "See Some Debate Law.",
      rewrittenCount: 0,
      attemptedCount: 0,
      strippedCount: 1,
    });
  });

  it("strips multiple unresolvable citations independently, in one pass", async () => {
    const content =
      "[First Law](https://hansard.parliament.uk/a) and " +
      '<a href="https://hansard.parliament.uk/b" class="legal-ref law">Second Law</a>.';
    const result = await rewriteLegalCitationLinks(content, "UK");
    expect(result).to.deep.equal({
      content: "First Law and Second Law.",
      rewrittenCount: 0,
      attemptedCount: 0,
      strippedCount: 2,
    });
  });
});
