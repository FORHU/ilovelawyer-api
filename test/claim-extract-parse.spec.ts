import { expect } from "chai";
import { describe, it } from "mocha";
import { claimTitleKey, extractClaims } from "../src/utils/claim-extract-parse";

const docs = new Map([
  ["d1", "COMPLAINT\nComplainant alleges that she was illegally dismissed\nwithout just cause on 11 August 2026."],
  ["d2", "Position paper. Respondent denies the claim."],
]);
const reply = (rows: unknown[]) => `[CLAIMS]\n${JSON.stringify(rows)}\n[/CLAIMS]`;

describe("extractClaims", () => {
  it("keeps a claim whose quote is in its document, even re-flowed", () => {
    const found = extractClaims(
      reply([
        {
          title: "Illegal dismissal",
          causeOfAction: "Labor Code, Art. 294",
          documentId: "d1",
          quote: "she was illegally dismissed without just cause",
        },
      ]),
      docs,
    );
    expect(found).to.deep.equal([
      {
        title: "Illegal dismissal",
        causeOfAction: "Labor Code, Art. 294",
        documentId: "d1",
        quote: "she was illegally dismissed without just cause",
      },
    ]);
  });

  it("drops a claim whose quote isn't in the cited document, or that cites an unknown document", () => {
    const found = extractClaims(
      reply([
        { title: "Unpaid wages", documentId: "d1", quote: "respondent failed to pay her wages" },
        { title: "Moral damages", documentId: "d9", quote: "she was illegally dismissed" },
      ]),
      docs,
    );
    expect(found).to.deep.equal([]);
  });

  it("merges repeats of the same claim and returns undefined when there's no block", () => {
    const found = extractClaims(
      reply([
        { title: "Illegal dismissal", documentId: "d1", quote: "illegally dismissed" },
        { title: "Claim for illegal dismissal.", documentId: "d1", quote: "without just cause" },
      ]),
      docs,
    );
    expect(found).to.have.length(1);
    expect(extractClaims("no block here", docs)).to.equal(undefined);
  });
});

describe("claimTitleKey", () => {
  it("ignores case, punctuation and a leading 'claim for'", () => {
    expect(claimTitleKey("Claim for Illegal Dismissal.")).to.equal(claimTitleKey("illegal dismissal"));
  });
});
