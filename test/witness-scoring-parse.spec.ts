import { expect } from "chai";
import { describe, it } from "mocha";
import { extractWitnessFactors, quoteAppearsIn } from "../src/utils/witness-scoring-parse";

const known = new Set(["w1", "w2"]);
const wrap = (json: string) => `Summary text.\n[SCORES]\n${json}\n[/SCORES]`;

describe("extractWitnessFactors", () => {
  it("parses factor answers, quotes and reasons", () => {
    const out = extractWitnessFactors(
      wrap(
        '[{"witnessId":"w1","factors":{"A":{"answer":"own","quote":"I saw him sign","document":"Affidavit"},"F":{"answer":"CENTRAL"}},"reasons":[{"text":"First-hand","source":"Email"}]}]',
      ),
      known,
    )!;
    expect(out).to.have.length(1);
    expect(out[0].factors.A).to.deep.equal({ answer: "OWN", quote: "I saw him sign", document: "Affidavit" });
    expect(out[0].factors.F.answer).to.equal("CENTRAL");
    expect(out[0].factors.B).to.deep.equal({ answer: null, quote: null, document: null });
    expect(out[0].reasons).to.deep.equal([{ text: "First-hand", source: "Email" }]);
  });

  it("drops an answer that is not one of the factor's options", () => {
    const out = extractWitnessFactors(wrap('[{"witnessId":"w1","factors":{"A":{"answer":"CENTRAL"},"B":{"answer":"MAYBE"}}}]'), known)!;
    expect(out[0].factors.A.answer).to.equal(null);
    expect(out[0].factors.B.answer).to.equal(null);
  });

  it("drops unknown and duplicate witness ids", () => {
    const out = extractWitnessFactors(
      wrap('[{"witnessId":"ghost"},{"witnessId":"w1","factors":{"A":{"answer":"OWN"}}},{"witnessId":"w1","factors":{"A":{"answer":"REPORTED"}}}]'),
      known,
    )!;
    expect(out).to.have.length(1);
    expect(out[0].factors.A.answer).to.equal("OWN");
  });

  it("caps reasons at four", () => {
    const reasons = Array.from({ length: 6 }, (_, i) => `{"text":"r${i}"}`).join(",");
    const out = extractWitnessFactors(wrap(`[{"witnessId":"w1","reasons":[${reasons}]}]`), known)!;
    expect(out[0].reasons).to.have.length(4);
    expect(out[0].reasons[0].source).to.equal(null);
  });

  it("returns undefined when there is no parseable block", () => {
    expect(extractWitnessFactors("no block here", known)).to.equal(undefined);
    expect(extractWitnessFactors(wrap("not json"), known)).to.equal(undefined);
  });
});

describe("quoteAppearsIn", () => {
  it("matches ignoring case, whitespace and curly quotes", () => {
    expect(quoteAppearsIn("I saw  him sign", "Yesterday, i saw\nhim sign the deed.")).to.equal(true);
    expect(quoteAppearsIn("it’s mine", "It's mine")).to.equal(true);
  });

  it("rejects text that is not in the source, and empty quotes", () => {
    expect(quoteAppearsIn("I saw him sign", "He never signed anything")).to.equal(false);
    expect(quoteAppearsIn("   ", "anything")).to.equal(false);
  });
});
