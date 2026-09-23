import { expect } from "chai";
import { describe, it } from "mocha";
import {
  isKnownLawHost,
  resolveRelatedCaseLibraryLinks,
  rewriteLegalCitationLinks,
  stripCitationSuffix,
} from "../src/utils/legal-citation-link-rewrite";
import type { RelatedCase } from "../src/utils/chatWonder";

function relatedCase(overrides: Partial<RelatedCase>): RelatedCase {
  return {
    type: "case",
    title: null,
    url: null,
    case_number: null,
    ra_number: null,
    year: null,
    snippet: null,
    relevance: null,
    vetted: false,
    ...overrides,
  };
}

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

describe("resolveRelatedCaseLibraryLinks", () => {
  it("leaves a PH item with no url at all unchanged", async () => {
    const items = [relatedCase({ title: "No URL here" })];
    const result = await resolveRelatedCaseLibraryLinks(items, "PH");
    expect(result).to.deep.equal(items);
  });

  // A PH item pointing somewhere that isn't juris.ph (e.g. a stray legislation.gov.uk link) has
  // no chance of matching the PH Library — same no-external-navigation policy as the UK path.
  it("strips the url of a PH item pointing to an unrecognized host, keeping everything else", async () => {
    const items = [relatedCase({ title: "Some UK Act", url: "https://www.legislation.gov.uk/ukpga/1967/87" })];
    const result = await resolveRelatedCaseLibraryLinks(items, "PH");
    expect(result).to.deep.equal([{ ...items[0], url: null }]);
  });

  it("leaves a UK item with no url at all unchanged", async () => {
    const items = [relatedCase({ title: "No URL here" })];
    const result = await resolveRelatedCaseLibraryLinks(items, "UK");
    expect(result).to.deep.equal(items);
  });

  // Same no-external-navigation policy as rewriteLegalCitationLinks: a related case pointing
  // somewhere that could never be a Library item must not stay a clickable external link.
  it("strips the url of a UK item pointing to an unrecognized host, keeping everything else", async () => {
    const items = [relatedCase({ title: "Some Debate", url: "https://hansard.parliament.uk/commons/2020" })];
    const result = await resolveRelatedCaseLibraryLinks(items, "UK");
    expect(result).to.deep.equal([{ ...items[0], url: null }]);
  });

  it("resolves independent items in one pass, each on its own merits", async () => {
    const items = [
      relatedCase({ title: "Keeps no url", url: null }),
      relatedCase({ title: "Gets stripped", url: "https://hansard.parliament.uk/x" }),
    ];
    const result = await resolveRelatedCaseLibraryLinks(items, "UK");
    expect(result[0]).to.deep.equal(items[0]);
    expect(result[1]).to.deep.equal({ ...items[1], url: null });
  });

  // Sources panel derives its displayed label from `url` when title/case_number/ra_number are
  // all null (a bare-URL related case) — nulling the url on strip must not leave the row with
  // nothing at all to show, so a host+path fallback title is backfilled in that case only.
  it("backfills a host+path fallback title when stripping a bare-URL item with no other label", async () => {
    const items = [relatedCase({ url: "https://hansard.parliament.uk/commons/2020" })];
    const result = await resolveRelatedCaseLibraryLinks(items, "UK");
    expect(result).to.deep.equal([{ ...items[0], url: null, title: "hansard.parliament.uk/commons/2020" }]);
  });

  it("does not overwrite an existing title when stripping", async () => {
    const items = [relatedCase({ title: "Some Debate", url: "https://hansard.parliament.uk/commons/2020" })];
    const result = await resolveRelatedCaseLibraryLinks(items, "UK");
    expect(result).to.deep.equal([{ ...items[0], url: null }]);
  });
});
