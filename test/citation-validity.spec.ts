/** #363: the citation-validity heuristic must not pass a quote that reverses its source.
 *
 * The fuzzy match used to accept 85% overlap of words longer than 3 letters found anywhere in the
 * official text, so a dropped or added "not"/"never" still read as VALID ("Quote matches") — and
 * VALID never reached Jev. Now a fuzzy match has to sit in one stretch of the source with the same
 * words negated, and a fuzzy (not word-for-word) VALID goes to Jev like an INVALID does.
 *
 * No live Jev: evaluateCitation takes the Jev call as a parameter, and the flag is read per call.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import {
  matchQuote,
  containsQuote,
  evaluateCitationHeuristic,
  evaluateCitation,
  CitationCheckResult,
} from "../src/utils/citation-validity";

const OFFICIAL =
  "The employer may terminate the employee without notice where the employee has committed serious misconduct.";

describe("matchQuote — exact, fuzzy or none", () => {
  it("an exact (normalized) quote is exact", () => {
    expect(matchQuote(OFFICIAL, "the employer may terminate the employee without notice")).to.equal("exact");
  });

  it("small harmless differences are a fuzzy match", () => {
    expect(matchQuote(OFFICIAL, "The employer can terminate the employee without notice where the employee committed serious misconduct")).to.equal("fuzzy");
  });

  it("adding 'not' is no match", () => {
    expect(matchQuote(OFFICIAL, "The employer may not terminate the employee without notice where the employee has committed serious misconduct.")).to.equal("none");
  });

  it("adding 'never' is no match", () => {
    expect(matchQuote(OFFICIAL, "The employer may terminate the employee without notice where the employee has never committed serious misconduct.")).to.equal("none");
  });

  it("dropping a negation the source has is no match", () => {
    const negated = "The employer may not terminate the employee without notice where the employee has committed serious misconduct.";
    expect(matchQuote(negated, "The employer may terminate the employee without notice where the employee has committed serious misconduct")).to.equal("none");
  });

  it("dropping 'without' (the source's own negation) is no match", () => {
    expect(matchQuote(OFFICIAL, "The employer may terminate the employee with notice where the employee has committed serious misconduct")).to.equal("none");
  });

  it("a negation both sides share still matches", () => {
    const official = "No person shall be deprived of life, liberty, or property without due process of law, nor shall any person be denied equal protection.";
    expect(matchQuote(official, "No person shall be deprived of life liberty or property without the due process of law")).to.equal("fuzzy");
  });

  it("the quote's words scattered across a long source are no match", () => {
    const scattered = [
      "The employer filed the petition in March.",
      "Several witnesses testified about the notice given to the workers.",
      "The court may terminate proceedings where the parties settle.",
      "The employee was never present at the hearing.",
      "Counsel argued the misconduct alleged was serious.",
      "The committed sum was paid without delay.",
    ].join(" ");
    expect(matchQuote(scattered, "The employer may terminate the employee without notice where the employee has committed serious misconduct")).to.equal("none");
  });

  it("containsQuote stays true for exact and fuzzy, false otherwise (citation-proposition relies on it)", () => {
    expect(containsQuote(OFFICIAL, "the employer may terminate the employee without notice")).to.equal(true);
    expect(containsQuote(OFFICIAL, "The employer may not terminate the employee without notice where the employee has committed serious misconduct")).to.equal(false);
  });
});

describe("evaluateCitationHeuristic", () => {
  it("the two reversed quotes from #363 are no longer VALID", () => {
    for (const quotedText of [
      "The employer may not terminate the employee without notice where the employee has committed serious misconduct.",
      "The employer may terminate the employee without notice where the employee has never committed serious misconduct.",
    ]) {
      expect(evaluateCitationHeuristic({ quotedText, officialText: OFFICIAL }).status).to.equal("INVALID");
    }
  });

  it("says whether a VALID was exact or fuzzy", () => {
    expect(evaluateCitationHeuristic({ quotedText: "the employer may terminate the employee", officialText: OFFICIAL })).to.include({ status: "VALID", match: "exact" });
    expect(
      evaluateCitationHeuristic({
        quotedText: "The employer can terminate the employee without notice where the employee committed serious misconduct",
        officialText: OFFICIAL,
      }),
    ).to.include({ status: "VALID", match: "fuzzy" });
  });
});

describe("evaluateCitation — which results Jev double-checks", () => {
  const original = process.env.USE_JEV_VALIDITY;
  let jevCalls: { quote: string; official: string }[];
  const fakeJev = async (quote: string, official: string): Promise<CitationCheckResult> => {
    jevCalls.push({ quote, official });
    return { status: "ADVERSE", notes: "Jev found the official text appears to contradict this citation." };
  };

  beforeEach(() => {
    jevCalls = [];
    process.env.USE_JEV_VALIDITY = "true";
  });
  afterEach(() => {
    if (original === undefined) delete process.env.USE_JEV_VALIDITY;
    else process.env.USE_JEV_VALIDITY = original;
  });

  it("an exact match is decided by the heuristic alone", async () => {
    const result = await evaluateCitation({ quotedText: "the employer may terminate the employee", officialText: OFFICIAL }, fakeJev);
    expect(result.status).to.equal("VALID");
    expect(jevCalls).to.have.length(0);
  });

  it("a fuzzy VALID goes to Jev, and Jev's answer wins", async () => {
    const result = await evaluateCitation(
      { quotedText: "The employer can terminate the employee without notice where the employee committed serious misconduct", officialText: OFFICIAL },
      fakeJev,
    );
    expect(jevCalls).to.have.length(1);
    expect(result.status).to.equal("ADVERSE");
  });

  it("an INVALID still goes to Jev — including a reversed quote", async () => {
    const result = await evaluateCitation(
      { quotedText: "The employer may not terminate the employee without notice where the employee has committed serious misconduct.", officialText: OFFICIAL },
      fakeJev,
    );
    expect(jevCalls).to.have.length(1);
    expect(result.status).to.equal("ADVERSE");
  });

  it("with no official text there's nothing to check, so no Jev call", async () => {
    const result = await evaluateCitation({ quotedText: "Due process of law" }, fakeJev);
    expect(result.status).to.equal("UNVERIFIED");
    expect(jevCalls).to.have.length(0);
  });

  it("with the flag off, Jev is never called", async () => {
    process.env.USE_JEV_VALIDITY = "false";
    const result = await evaluateCitation(
      { quotedText: "The employer can terminate the employee without notice where the employee committed serious misconduct", officialText: OFFICIAL },
      fakeJev,
    );
    expect(result.status).to.equal("VALID");
    expect(jevCalls).to.have.length(0);
  });

  it("if Jev fails, the heuristic's answer stands", async () => {
    const failing = async (): Promise<CitationCheckResult> => {
      throw new Error("network down");
    };
    const result = await evaluateCitation(
      { quotedText: "The employer may not terminate the employee without notice where the employee has committed serious misconduct.", officialText: OFFICIAL },
      failing,
    );
    expect(result.status).to.equal("INVALID");
  });
});
