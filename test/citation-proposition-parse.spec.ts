import { expect } from "chai";
import { describe, it } from "mocha";
import { extractProposition } from "../src/utils/citation-proposition-parse";

describe("extractProposition", () => {
  it("returns null when there is no [PROPOSITION] block at all", () => {
    expect(extractProposition("just a plain reply")).to.equal(null);
  });

  it("parses a well-formed PARAPHRASED block", () => {
    const text = `[PROPOSITION]\n{"type": "PARAPHRASED", "reasoning": "Same fact, different wording."}\n[/PROPOSITION]`;
    expect(extractProposition(text)).to.deep.equal({ type: "PARAPHRASED", reasoning: "Same fact, different wording." });
  });

  it("collapses UNSUPPORTED to INFERRED — the enum only has the three memo-asked values", () => {
    const text = `[PROPOSITION]{"type": "UNSUPPORTED", "reasoning": "Not stated."}[/PROPOSITION]`;
    expect(extractProposition(text)).to.deep.equal({ type: "INFERRED", reasoning: "Not stated." });
  });

  it("returns null for an unrecognized type rather than guessing", () => {
    const text = `[PROPOSITION]{"type": "MADE_UP"}[/PROPOSITION]`;
    expect(extractProposition(text)).to.equal(null);
  });

  it("falls back to an open tag when the closing tag is missing", () => {
    const text = `[PROPOSITION]\n{"type": "INFERRED"}`;
    expect(extractProposition(text)).to.deep.equal({ type: "INFERRED", reasoning: null });
  });

  it("strips Chat Wonder noise before looking for the block", () => {
    const text = `[PROPOSITION]{"type": "PARAPHRASED"}[/PROPOSITION]\n[Sources]\n- some source`;
    expect(extractProposition(text)).to.deep.equal({ type: "PARAPHRASED", reasoning: null });
  });
});
