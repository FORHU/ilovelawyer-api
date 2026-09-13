import { expect } from "chai";
import { describe, it } from "mocha";
import { parseTheoryProposal, parseTheoryDiff } from "../src/utils/theory-parse";

describe("parseTheoryProposal", () => {
  it("parses a well-formed [THEORY_PROPOSAL] block", () => {
    const text = `[THEORY_PROPOSAL]
{"title": "Structural neglect", "thesis": "The collapse was caused by known, unaddressed defects.",
"claims": [{"statement": "The through-ties were missing", "stance": "ASSERTS"}, {"statement": "Wind alone caused it", "stance": "DENIES"}],
"assumptions": ["The 2019 survey is accurate"],
"openQuestions": ["Who signed off on the 2019 remedial works?"]}
[/THEORY_PROPOSAL]`;
    const parsed = parseTheoryProposal(text);
    expect(parsed).to.not.be.undefined;
    expect(parsed!.title).to.equal("Structural neglect");
    expect(parsed!.claims).to.have.length(2);
    expect(parsed!.claims[0]).to.deep.equal({ statement: "The through-ties were missing", stance: "ASSERTS" });
    expect(parsed!.assumptions).to.deep.equal(["The 2019 survey is accurate"]);
    expect(parsed!.openQuestions).to.deep.equal(["Who signed off on the 2019 remedial works?"]);
  });

  it("returns undefined when the tag is missing", () => {
    expect(parseTheoryProposal("Just some prose with no tags.")).to.be.undefined;
  });

  it("returns undefined when title or thesis is missing", () => {
    const text = `[THEORY_PROPOSAL]{"thesis": "Only a thesis"}[/THEORY_PROPOSAL]`;
    expect(parseTheoryProposal(text)).to.be.undefined;
  });

  it("drops claims with an invalid stance rather than guessing one", () => {
    const text = `[THEORY_PROPOSAL]{"title": "T", "thesis": "X", "claims": [{"statement": "a", "stance": "MAYBE"}, {"statement": "b", "stance": "ASSERTS"}]}[/THEORY_PROPOSAL]`;
    const parsed = parseTheoryProposal(text);
    expect(parsed!.claims).to.have.length(1);
    expect(parsed!.claims[0].statement).to.equal("b");
  });

  it("defaults missing arrays to empty", () => {
    const text = `[THEORY_PROPOSAL]{"title": "T", "thesis": "X"}[/THEORY_PROPOSAL]`;
    const parsed = parseTheoryProposal(text);
    expect(parsed!.claims).to.deep.equal([]);
    expect(parsed!.assumptions).to.deep.equal([]);
    expect(parsed!.openQuestions).to.deep.equal([]);
  });

  it("tolerates a ```json code fence inside the tag", () => {
    const text = "[THEORY_PROPOSAL]\n```json\n{\"title\": \"T\", \"thesis\": \"X\"}\n```\n[/THEORY_PROPOSAL]";
    const parsed = parseTheoryProposal(text);
    expect(parsed!.title).to.equal("T");
  });

  it("handles malformed JSON without throwing", () => {
    const text = `[THEORY_PROPOSAL]{not json at all[/THEORY_PROPOSAL]`;
    expect(parseTheoryProposal(text)).to.be.undefined;
  });
});

describe("parseTheoryDiff", () => {
  it("parses a well-formed [THEORY_DIFF] block", () => {
    const text = `[THEORY_DIFF]
{"sharedClaims": ["Both agree D08 is disputed"],
"divergentClaims": [{"claimA": "D08 is genuine", "claimB": "D08 is fabricated", "decidingEvidence": "The paper original", "missing": "D08's paper original was never produced"}]}
[/THEORY_DIFF]`;
    const parsed = parseTheoryDiff(text);
    expect(parsed).to.not.be.undefined;
    expect(parsed!.sharedClaims).to.deep.equal(["Both agree D08 is disputed"]);
    expect(parsed!.divergentClaims).to.have.length(1);
    expect(parsed!.divergentClaims[0].decidingEvidence).to.equal("The paper original");
  });

  it("returns undefined when the tag is missing", () => {
    expect(parseTheoryDiff("no tags here")).to.be.undefined;
  });

  it("is valid with both arrays empty — 'nothing shared, nothing divergent' is a real answer", () => {
    const text = `[THEORY_DIFF]{"sharedClaims": [], "divergentClaims": []}[/THEORY_DIFF]`;
    const parsed = parseTheoryDiff(text);
    expect(parsed).to.deep.equal({ sharedClaims: [], divergentClaims: [] });
  });

  it("drops a divergent entry missing claimA or claimB", () => {
    const text = `[THEORY_DIFF]{"sharedClaims": [], "divergentClaims": [{"claimA": "only A"}, {"claimA": "a", "claimB": "b"}]}[/THEORY_DIFF]`;
    const parsed = parseTheoryDiff(text);
    expect(parsed!.divergentClaims).to.have.length(1);
    expect(parsed!.divergentClaims[0]).to.deep.equal({ claimA: "a", claimB: "b", decidingEvidence: "", missing: "" });
  });

  it("handles malformed JSON without throwing", () => {
    expect(parseTheoryDiff("[THEORY_DIFF]{broken[/THEORY_DIFF]")).to.be.undefined;
  });
});
