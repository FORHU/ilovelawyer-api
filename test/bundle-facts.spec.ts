import { expect } from "chai";
import { describe, it } from "mocha";
import { extractBundleFacts, BundleChunk } from "../src/utils/bundle-facts";

let n = 0;
const chunk = (text: string, pageNumber: number | null = 1, doc = "doc-1"): BundleChunk => ({
  id: `c${++n}`,
  caseDocumentId: doc,
  chunkIndex: n,
  pageNumber,
  chunkText: text,
});
const uk = { numericDayFirst: true };
const values = (chunks: BundleChunk[], opts = uk) => extractBundleFacts(chunks, opts).map((f) => `${f.kind}:${f.value}`);

describe("extractBundleFacts", () => {
  it("reads UK and PH date formats", () => {
    expect(values([chunk("Served on 14 November 2023 and again 3rd Dec. 2023.")])).to.deep.equal(["date:2023-11-14", "date:2023-12-03"]);
    expect(values([chunk("Dated August 4, 2024.")])).to.deep.equal(["date:2024-08-04"]);
    expect(values([chunk("Log 16.11.2023 and 2024-02-19.")])).to.deep.equal(["date:2023-11-16", "date:2024-02-19"]);
  });

  it("reads slashed dates by tenant: day-first for UK, month-first otherwise", () => {
    expect(values([chunk("Signed 03/04/2024.")], { numericDayFirst: true })).to.deep.equal(["date:2024-04-03"]);
    expect(values([chunk("Signed 03/04/2024.")], { numericDayFirst: false })).to.deep.equal(["date:2024-03-04"]);
  });

  it("rejects impossible dates", () => {
    expect(values([chunk("On 31 February 2024 and 45.13.2023.")])).to.deep.equal([]);
  });

  it("takes a year-less date's year from the nearest full date before it, and flags it", () => {
    const facts = extractBundleFacts(
      [chunk("The incident on 14 November 2023 was reported."), chunk("You wiped it on 22 November, the day it was seized.")],
      uk,
    );
    const wiped = facts.find((f) => f.value === "2023-11-22")!;
    expect(wiped.yearInferred).to.equal(true);
    expect(facts.find((f) => f.value === "2023-11-14")!.yearInferred).to.equal(false);
  });

  it("drops a year-less date with no year in context", () => {
    expect(values([chunk("Nothing happened on 22 November.")])).to.deep.equal([]);
  });

  it("reads amounts in several currencies, with k/m suffixes", () => {
    expect(values([chunk("Paid £4,500 then ₱12,000.50 and $2.5m.")])).to.deep.equal([
      "amount:GBP4500.00",
      "amount:PHP12000.50",
      "amount:USD2500000.00",
    ]);
  });

  it("reads durations in words or digits, normalized to days", () => {
    expect(values([chunk("Installed eleven days later; retention is 31 days, or 2 weeks.")])).to.deep.equal([
      "duration:11d",
      "duration:31d",
      "duration:14d",
    ]);
  });

  it("tracks the exhibit and its page across chunks from cover lines and footers", () => {
    const facts = extractBundleFacts(
      [
        chunk("BUNDLE DOCUMENT 13 OF 21", 31),
        chunk("Case ref D13 / p.1", 31),
        chunk("Notice served on 21 November 2023.", 31),
        chunk("Fault closed on 3 November 2023.", 32),
        chunk("BUNDLE DOCUMENT 14 OF 21", 33),
        chunk("Entry dated 16 November 2023.", 33),
      ],
      uk,
    );
    const at = (v: string) => facts.find((f) => f.value === v)!;
    expect(at("2023-11-21")).to.include({ exhibit: "D13", locator: "D13 p.1" });
    expect(at("2023-11-03")).to.include({ exhibit: "D13", locator: "D13 p.2" });
    expect(at("2023-11-16")).to.include({ exhibit: "D14", locator: "D14" });
  });

  it("does not take 'Exhibit Bundle' for an exhibit named Bundle", () => {
    const facts = extractBundleFacts([chunk("Exhibit Bundle index\nPaid on 4 May 2024.", 5)], uk);
    expect(facts[0]).to.include({ exhibit: null, locator: "p.5" });
  });

  it("keeps the sentence around each value", () => {
    const [fact] = extractBundleFacts([chunk("Intro line. The cameras were not recording on 14 November 2023. Next.")], uk);
    expect(fact.sentence).to.equal("The cameras were not recording on 14 November 2023.");
  });
});
