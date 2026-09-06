import { expect } from "chai";
import { describe, it } from "mocha";
import { extractCitations } from "../src/utils/citation-extraction-parse";

describe("extractCitations", () => {
  it("returns undefined when there is no [CITATIONS] block at all", () => {
    expect(extractCitations("just a plain reply with no tags")).to.equal(undefined);
  });

  it("returns an empty array when the model explicitly found nothing", () => {
    expect(extractCitations("[CITATIONS]\n[]\n[/CITATIONS]")).to.deep.equal([]);
  });

  it("parses a well-formed closed block", () => {
    const text = `[CITATIONS]
[{"caseNumber": "G.R. No. 179936", "title": "People v. Santos", "year": 2020, "treatment": "FOLLOWED", "excerpt": "as held in People v. Santos"}]
[/CITATIONS]`;
    expect(extractCitations(text)).to.deep.equal([
      {
        caseNumber: "G.R. No. 179936",
        title: "People v. Santos",
        year: 2020,
        treatment: "FOLLOWED",
        excerpt: "as held in People v. Santos",
      },
    ]);
  });

  it("falls back to an open tag when the closing tag is missing (streaming cutoff)", () => {
    const text = `[CITATIONS]\n[{"caseNumber": "G.R. No. 1", "treatment": "CITED"}]`;
    const result = extractCitations(text);
    expect(result).to.have.length(1);
    expect(result![0].caseNumber).to.equal("G.R. No. 1");
  });

  it("drops rows with neither a caseNumber nor a title — nothing to resolve or show", () => {
    const text = `[CITATIONS][{"treatment": "CITED", "excerpt": "no name given"}][/CITATIONS]`;
    expect(extractCitations(text)).to.deep.equal([]);
  });

  it("defaults an invalid/missing treatment to CITED rather than dropping the row", () => {
    const text = `[CITATIONS][{"caseNumber": "G.R. No. 1", "treatment": "MADE_UP"}][/CITATIONS]`;
    const result = extractCitations(text);
    expect(result![0].treatment).to.equal("CITED");
  });

  it("caps at 10 items even when the model returns more", () => {
    const items = Array.from({ length: 15 }, (_, i) => ({ caseNumber: `G.R. No. ${i}`, treatment: "CITED" }));
    const text = `[CITATIONS]${JSON.stringify(items)}[/CITATIONS]`;
    expect(extractCitations(text)).to.have.length(10);
  });

  it("strips Chat Wonder noise before looking for the block", () => {
    const text = `[CITATIONS][{"caseNumber": "G.R. No. 1", "treatment": "CITED"}][/CITATIONS]\n[Sources]\n- some source`;
    const result = extractCitations(text);
    expect(result).to.have.length(1);
  });
});
