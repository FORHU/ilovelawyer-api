import { expect } from "chai";
import { describe, it } from "mocha";
import { buildLexicalQuery, extractAnchors } from "../src/utils/hybridSearch";

describe("buildLexicalQuery", () => {
  it("ORs the exact references a legal question cites, not its prose", () => {
    const q = buildLexicalQuery(
      "Item D20.3 and D10 item 10.6. Does legal advice privilege attach? What should Halloway Brant LLP now do, given the note at the end of D20.3?",
    );
    expect(q).to.include("D20.3");
    expect(q).to.include("D10");
    expect(q).to.include('"10.6"');
    expect(q).to.include('"Halloway Brant"');
    expect(q).to.include(" OR ");
    expect(q).to.not.include("privilege");
  });

  it("captures money, times, percentages, section refs, dates, titled names and quoted phrases", () => {
    const anchors = extractAnchors(
      'Was the £1,842,500 sum, certified at 02:40 on 30 November 2023 by Mr Pilbeam under cl. 4.9.4, "fraudulent" given the 61% dependence and s.103A?',
    );
    expect(anchors).to.include.members(["£1,842,500", "02:40", "30 November 2023", "Mr Pilbeam", "cl. 4.9.4", "fraudulent", "61%", "s.103A"]);
  });

  it("does not treat apostrophes as quoted phrases", () => {
    const anchors = extractAnchors("Coldbrook's alternative case that Meridian's application wasn't valid");
    expect(anchors.some((a) => a.includes("s alternative"))).to.equal(false);
  });

  it("stands down to vector-only when a question cites no exact references", () => {
    // An OR of content words matches nearly every chunk of a bundle and ts_rank_cd then ranks
    // by verbosity — worse than not running the lexical channel at all.
    expect(buildLexicalQuery("did the site manager know the scaffold was unsafe")).to.equal("");
  });

  it("stands down when a question cites only one reference", () => {
    expect(buildLexicalQuery("what does D05 say about the handover?")).to.equal("");
  });

  it("returns an empty string for blank input", () => {
    expect(buildLexicalQuery("   ")).to.equal("");
  });
});
