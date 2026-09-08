import { expect } from "chai";
import { describe, it } from "mocha";
import { allocatePerDocumentBudget } from "../src/utils/case-document-excerpts";

type Item = { id: string };

function pool(prefix: string, count: number): Item[] {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}` }));
}

function docIdsOf(items: Item[]): Set<string> {
  return new Set(items.map((item) => item.id.split("-")[0]));
}

describe("allocatePerDocumentBudget", () => {
  it("gives every non-empty pool at least a floor share on a 20-document case (the reported bug)", () => {
    // 20 exhibits, wildly uneven in size — one 300-chunk ledger plus nineteen 2-chunk letters.
    // The previous flat case-wide top-32 selection would let the ledger's textually-similar
    // chunks fill most or all of the 32 slots, leaving several of the 2-chunk exhibits with zero
    // representation — reproducing the benchmark's "Exhibit D/N is unavailable" failure.
    const pools = [pool("ledger", 300), ...Array.from({ length: 19 }, (_, i) => pool(`ex${i}`, 2))];

    const result = allocatePerDocumentBudget(pools, 32);

    result.forEach((chosen, i) => {
      expect(chosen.length, `pool ${i} got zero chunks`).to.be.greaterThan(0);
    });
  });

  it("never selects more than a pool actually has", () => {
    const pools = [pool("a", 1), pool("b", 3), pool("c", 50)];
    const result = allocatePerDocumentBudget(pools, 32);
    result.forEach((chosen, i) => expect(chosen.length).to.be.at.most(pools[i].length));
  });

  it("distributes leftover budget to pools with more content once every pool has its floor", () => {
    // budget 10, 2 pools -> base quota 5 each. Pool "small" only has 2 items, so 3 slots go
    // unused by it and should roll over to "big" instead of being wasted.
    const pools = [pool("small", 2), pool("big", 20)];
    const result = allocatePerDocumentBudget(pools, 10);
    const [small, big] = result;
    expect(small.length).to.equal(2);
    expect(big.length).to.equal(8); // 5 (floor) + 3 (small's unused floor share)
  });

  it("returns all items unselected as empty arrays when the total budget is exhausted by earlier pools' floors", () => {
    const pools = [pool("a", 5), pool("b", 5), pool("c", 5)];
    // budget smaller than pool count: floor share is still at least 1 per pool by construction.
    const result = allocatePerDocumentBudget(pools, 3);
    result.forEach((chosen) => expect(chosen.length).to.equal(1));
  });

  it("handles a totally empty case (no documents) without throwing", () => {
    expect(allocatePerDocumentBudget([], 32)).to.deep.equal([]);
  });

  it("skips empty pools without giving them a phantom floor share", () => {
    const pools = [pool("a", 5), [], pool("c", 5)];
    const result = allocatePerDocumentBudget(pools, 32);
    expect(result[1]).to.deep.equal([]);
    expect(result[0].length).to.be.greaterThan(0);
    expect(result[2].length).to.be.greaterThan(0);
  });

  it("never selects the same item twice within one pool", () => {
    const pools = [pool("a", 40)];
    const result = allocatePerDocumentBudget(pools, 32);
    const ids = result[0].map((item) => item.id);
    expect(new Set(ids).size).to.equal(ids.length);
  });

  // Sanity check tying the unit back to the reported symptom in plain terms.
  it("covers every exhibit letter in a 20-exhibit case, matching the benchmark's Exhibits A-T", () => {
    const letters = "ABCDEFGHIJKLMNOPQRST".split("");
    const pools = letters.map((letter, i) =>
      // Exhibit D (a short admission letter) has just 1 chunk; everything else has 15.
      pool(letter, letter === "D" ? 1 : 15),
    );
    const result = allocatePerDocumentBudget(pools, 32);
    const coveredLetters = docIdsOf(result.flat());
    for (const letter of letters) {
      expect(coveredLetters.has(letter), `Exhibit ${letter} got no chunks`).to.equal(true);
    }
  });
});
