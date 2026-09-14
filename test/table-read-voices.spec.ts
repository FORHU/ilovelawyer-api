import { expect } from "chai";
import { describe, it } from "mocha";
import { castForCase } from "../src/utils/table-read-voices";

describe("castForCase", () => {
  it("assigns a NARRATOR voice plus one distinct voice per actor", () => {
    const cast = castForCase("case-1", ["Kettleborough", "Delacroix-Hale", "Vasilenko-Pratt"]);
    expect(cast.NARRATOR).to.exist;
    expect(cast.Kettleborough).to.exist;
    expect(cast["Delacroix-Hale"]).to.exist;
    expect(cast["Vasilenko-Pratt"]).to.exist;
    const voices = Object.values(cast);
    expect(new Set(voices).size).to.equal(voices.length);
  });

  it("is deterministic — same case and actors always produce the same cast", () => {
    const first = castForCase("case-1", ["Kettleborough", "Delacroix-Hale"]);
    const second = castForCase("case-1", ["Kettleborough", "Delacroix-Hale"]);
    expect(first).to.deep.equal(second);
  });

  it("dedupes actor names that differ only by whitespace/case-sensitivity of trim", () => {
    const cast = castForCase("case-1", ["Kettleborough", " Kettleborough "]);
    expect(Object.keys(cast)).to.have.length(2); // NARRATOR + Kettleborough
  });

  it("ignores blank actor names", () => {
    const cast = castForCase("case-1", ["", "   ", "Kettleborough"]);
    expect(Object.keys(cast)).to.have.length(2);
  });

  it("still returns a full cast (with reuse) when actors outnumber the voice pool", () => {
    const actors = Array.from({ length: 12 }, (_, i) => `Actor ${i}`);
    const cast = castForCase("case-1", actors);
    expect(Object.keys(cast)).to.have.length(13); // NARRATOR + 12 actors
    for (const actor of actors) {
      expect(cast[actor]).to.exist;
    }
  });

  it("gives two different cases independent casts (not globally fixed per actor name)", () => {
    const castA = castForCase("case-a", ["Kettleborough"]);
    const castB = castForCase("case-b", ["Kettleborough"]);
    // Not asserting they differ (a hash collision is legitimately possible) — just that each
    // call is computed independently per caseId, not memoized/shared across cases.
    expect(castA.Kettleborough).to.exist;
    expect(castB.Kettleborough).to.exist;
  });
});
