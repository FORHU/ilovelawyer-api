/** toLawPreview / truncateAtWord — the chat citation hover card's payload (GET /api/law/preview).
 * Pure functions over a Law row, no DB. */
import { expect } from "chai";
import { describe, it } from "mocha";
import { PREVIEW_SNIPPET_MAX, toLawPreview, truncateAtWord } from "../src/utils/law-preview";

function row(over: Partial<Parameters<typeof toLawPreview>[0]> = {}): Parameters<typeof toLawPreview>[0] {
  return {
    title: "Anti-Violence Against Women and Their Children Act of 2004",
    caseNumber: null,
    raNumber: "R.A. No. 9262",
    year: 2004,
    division: null,
    summary: null,
    disposition: null,
    facts: null,
    keyProvisions: [],
    fullText: null,
    ...over,
  };
}

describe("truncateAtWord", () => {
  it("returns short text unchanged, with whitespace collapsed", () => {
    expect(truncateAtWord("  a\n\nshort   text ", 50)).to.equal("a short text");
  });

  it("cuts at the last word boundary and appends an ellipsis", () => {
    expect(truncateAtWord("alpha beta gamma delta", 13)).to.equal("alpha beta…");
  });

  it("drops trailing punctuation before the ellipsis", () => {
    expect(truncateAtWord("alpha beta, gamma delta", 12)).to.equal("alpha beta…");
  });

  it("hard-cuts a single overlong word rather than returning almost nothing", () => {
    expect(truncateAtWord("a supercalifragilistic", 10)).to.equal("a supercal…");
  });
});

describe("toLawPreview", () => {
  it("maps the header fields", () => {
    const preview = toLawPreview(row({ caseNumber: "G.R. No. 1", division: "En Banc", summary: "s" }));
    expect(preview).to.deep.equal({
      title: "Anti-Violence Against Women and Their Children Act of 2004",
      reference: "G.R. No. 1",
      year: 2004,
      court: "En Banc",
      snippet: "s",
    });
  });

  it("falls back to raNumber when there's no caseNumber", () => {
    expect(toLawPreview(row()).reference).to.equal("R.A. No. 9262");
  });

  it("takes the snippet from the first non-empty source in priority order", () => {
    expect(toLawPreview(row({ summary: "sum", disposition: "disp", facts: "facts" })).snippet).to.equal("sum");
    expect(toLawPreview(row({ summary: "  ", disposition: "disp", facts: "facts" })).snippet).to.equal("disp");
    expect(toLawPreview(row({ facts: "facts", keyProvisions: ["kp"] })).snippet).to.equal("facts");
    expect(toLawPreview(row({ keyProvisions: ["kp"], fullText: "full" })).snippet).to.equal("kp");
    expect(toLawPreview(row({ fullText: "full" })).snippet).to.equal("full");
  });

  it("falls back to a UK judgment's first paragraph preview", () => {
    const sections = [{ title: "para_1", summary: "  " }, { title: "para_2", summary: "The appellant was convicted." }];
    expect(toLawPreview(row({ category: "JURISPRUDENCE", sections })).snippet).to.equal("The appellant was convicted.");
  });

  it("does not treat a legislation TOC's section ids as a snippet", () => {
    expect(toLawPreview(row({ category: "REPUBLIC_ACT", sections: [{ title: "Short title", summary: "s. 1" }] })).snippet).to.equal(null);
  });

  it("skips repealed UK sections (dot leaders only) and cleans the first real provision", () => {
    const repealed = ". . . . . . . . . . . . . . . .: . . . . . . . . . . . . . . . .  1";
    const real =
      "Conspiring or soliciting to commit murder.: Conspiring or soliciting to commit murder. 4 . . . Whosoever shall solicit any person to murder any other person";
    expect(toLawPreview(row({ keyProvisions: [repealed, repealed, real] })).snippet).to.equal(
      "Whosoever shall solicit any person to murder any other person",
    );
  });

  it("returns a null snippet when every stored provision is repealed", () => {
    expect(toLawPreview(row({ keyProvisions: [". . . . . . . .: . . . . . . . .  1"] })).snippet).to.equal(null);
  });

  it("returns a null snippet when nothing is stored", () => {
    expect(toLawPreview(row()).snippet).to.equal(null);
  });

  it("truncates a long snippet to PREVIEW_SNIPPET_MAX", () => {
    const snippet = toLawPreview(row({ fullText: "word ".repeat(200) })).snippet!;
    expect(snippet.length).to.be.at.most(PREVIEW_SNIPPET_MAX + 1);
    expect(snippet.endsWith("…")).to.equal(true);
  });
});
