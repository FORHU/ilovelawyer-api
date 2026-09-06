import { expect } from "chai";
import { describe, it } from "mocha";
import { extractReconstructionClaims } from "../src/utils/case-reconstruction-claims-parse";

describe("extractReconstructionClaims", () => {
  it("returns undefined when there is no [CLAIMS] block at all", () => {
    expect(extractReconstructionClaims("just a plain narrative with no tags")).to.equal(undefined);
  });

  it("returns an empty array when the model explicitly found nothing to flag", () => {
    expect(extractReconstructionClaims("[CLAIMS]\n[]\n[/CLAIMS]")).to.deep.equal([]);
  });

  it("parses a well-formed closed block", () => {
    const text = `[CLAIMS]
[{"text": "The lease was signed on March 3.", "category": "GROUNDED", "sourceLabel": "Lease Agreement.pdf"}]
[/CLAIMS]`;
    expect(extractReconstructionClaims(text)).to.deep.equal([
      { text: "The lease was signed on March 3.", category: "GROUNDED", sourceLabel: "Lease Agreement.pdf" },
    ]);
  });

  it("falls back to an open tag when the closing tag is missing (streaming cutoff)", () => {
    const text = `[CLAIMS]\n[{"text": "Some claim", "category": "INFERENCE"}]`;
    const result = extractReconstructionClaims(text);
    expect(result).to.have.length(1);
    expect(result![0].text).to.equal("Some claim");
  });

  it("drops rows with no text — nothing to match back onto the narrative", () => {
    const text = `[CLAIMS][{"category": "INFERENCE"}][/CLAIMS]`;
    expect(extractReconstructionClaims(text)).to.deep.equal([]);
  });

  it("defaults an invalid/missing category to UNSUPPORTED rather than dropping the row", () => {
    const text = `[CLAIMS][{"text": "Some claim", "category": "MADE_UP"}][/CLAIMS]`;
    const result = extractReconstructionClaims(text);
    expect(result![0].category).to.equal("UNSUPPORTED");
  });

  it("clears sourceLabel for non-GROUNDED categories even if the model supplied one", () => {
    const text = `[CLAIMS][{"text": "Some claim", "category": "INFERENCE", "sourceLabel": "should be ignored"}][/CLAIMS]`;
    const result = extractReconstructionClaims(text);
    expect(result![0].sourceLabel).to.equal(null);
  });

  it("caps at 30 items even when the model returns more", () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ text: `Claim ${i}`, category: "INFERENCE" }));
    const text = `[CLAIMS]${JSON.stringify(items)}[/CLAIMS]`;
    expect(extractReconstructionClaims(text)).to.have.length(30);
  });

  it("strips Chat Wonder noise before looking for the block", () => {
    const text = `[CLAIMS][{"text": "Some claim", "category": "INFERENCE"}][/CLAIMS]\n[Sources]\n- some source`;
    const result = extractReconstructionClaims(text);
    expect(result).to.have.length(1);
  });
});
