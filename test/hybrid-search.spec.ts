import { expect } from "chai";
import { describe, it } from "mocha";
import { buildLexicalQuery, extractAnchors, reciprocalRankFusion, topNByScore } from "../src/utils/hybridSearch";

describe("reciprocalRankFusion", () => {
  it("ranks an id present in both lists above one present in only one", () => {
    const fused = topNByScore(reciprocalRankFusion([["a", "b"], ["b", "c"]]), 3);
    expect(fused[0]).to.equal("b");
  });

  it("with one empty list, reproduces the other list's order", () => {
    const fused = topNByScore(reciprocalRankFusion([["x", "y", "z"], []]), 3);
    expect(fused).to.deep.equal(["x", "y", "z"]);
  });

  it("lets a top lexical hit outrank a mid-table vector hit", () => {
    // "cite" is rank 1 lexically and absent from vector; "v3" is rank 3 in vector only.
    const fused = topNByScore(reciprocalRankFusion([["v1", "v2", "v3"], ["cite"]]), 4);
    expect(fused.indexOf("cite")).to.be.lessThan(fused.indexOf("v3"));
  });

  it("scores by 1/(k + rank)", () => {
    const scores = reciprocalRankFusion([["a"]], 60);
    expect(scores.get("a")).to.be.closeTo(1 / 61, 1e-12);
  });

  it("topNByScore caps the result and keeps first-seen order on ties", () => {
    const fused = topNByScore(reciprocalRankFusion([["a", "b"], ["c", "d"]]), 2);
    expect(fused).to.deep.equal(["a", "c"]);
  });
});

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

  it("falls back to OR-ed content words when a question has no references", () => {
    expect(buildLexicalQuery("did the site manager know the scaffold was unsafe")).to.equal(
      "site OR manager OR know OR scaffold OR unsafe",
    );
  });

  it("returns an empty string for blank input", () => {
    expect(buildLexicalQuery("   ")).to.equal("");
  });
});
