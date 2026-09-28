import { expect } from "chai";
import { describe, it } from "mocha";
import { buildAuthorityState, suggestAuthorityStance } from "../src/utils/authority-stance-jev";

describe("authority stance Jev", () => {
  it("keeps only the fields that have content and caps the source text", () => {
    const state = buildAuthorityState({
      ground: "Was there just cause under Art. 297?",
      title: " Agabon v. NLRC ",
      subtitle: "",
      citation: "G.R. No. 158693",
      rationale: null,
      lawText: "x".repeat(5000),
    });
    expect(Object.keys(state)).to.deep.equal(["authority", "ground", "citation", "sourceText"]);
    expect(state.authority).to.equal("Agabon v. NLRC");
    expect(state.sourceText).to.have.length(3000);
  });

  it("returns null without calling Jev when the flag is off", async () => {
    delete process.env.USE_JEV_AUTHORITY;
    expect(await suggestAuthorityStance({ ground: null, title: "Labor Code, Art. 297" })).to.equal(null);
  });
});
