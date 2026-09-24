import { expect } from "chai";
import { describe, it } from "mocha";
import {
  parseCitations,
  splitSentences,
  parseAbsenceClaims,
  parseCitedAssertions,
  documentLabelsFor,
  buildBundleView,
  classifyAbsence,
  scanAnswer,
} from "../src/utils/answer-grounding";

/** Verbatim from benchmarks/brackenmoor/answers/2026-09-21-seeded-jev-off — real generated text,
 * not invented fixtures, so the parser is held to what the model actually writes. */
const REAL = {
  citationList: "The evidential basis for those matters comes from D01, D06, D08, D11, D12, D14, D19 and D20.1.",
  assertionWithParen:
    "In his prepared statement he describes his role as strategic, involving resourcing, commercial delivery and client relationships across the division, while denying responsibility for day-to-day site operations (D07 para. 4).",
  assertionWithRange: "There had been no separate SHEQ director since a February 2023 restructure (D06 paras 1–2).",
  thirdPartyDisclosure: "Obtain all photographs not supplied to Dr Vantrease.",
  falseAbsence: "The complete paragraph is not reproduced in the material presently available, so the formulation should be treated as provisional (D20.1 para. 6).",
  absenceNoCitation: "I therefore cannot responsibly assert the contents of paragraphs or sections that are not reproduced in the supplied case context.",
};

describe("answer grounding — citation parsing", () => {
  it("reads the reference forms the graded answers actually used", () => {
    const cases: [string, { document: string; part?: string; locator?: string }][] = [
      ["D05", { document: "D05" }],
      ["D20.1 para. 7", { document: "D20", part: "1", locator: "para. 7" }],
      ["D12 Part 3", { document: "D12", locator: "Part 3" }],
      ["D06 paras 10–14", { document: "D06", locator: "paras 10–14" }],
      ["D10 item 10.6", { document: "D10", locator: "item 10.6" }],
      ["D11 s.1", { document: "D11", locator: "s. 1" }],
      ["D14 Parts 1 and 2", { document: "D14", locator: "Parts 1 and 2" }],
    ];
    for (const [text, want] of cases) {
      const [got] = parseCitations(text);
      expect(got, text).to.exist;
      expect(got.document, text).to.equal(want.document);
      expect(got.part, text).to.equal(want.part);
      expect(got.locator, text).to.equal(want.locator);
    }
  });

  it("keeps a decimal locator whole — 'item 10.6' must not truncate to 'item 10'", () => {
    expect(parseCitations("D10 item 10.6")[0].locator).to.equal("item 10.6");
  });

  it("normalises the document number so D5 and D05 are the same document", () => {
    expect(parseCitations("D5 Part 2")[0].document).to.equal("D05");
  });

  it("finds every reference in a list sentence", () => {
    expect(parseCitations(REAL.citationList).map((c) => c.document)).to.deep.equal(["D01", "D06", "D08", "D11", "D12", "D14", "D19", "D20"]);
  });

  it("records where each reference sits so a verdict can be anchored to the text", () => {
    const [first, second] = parseCitations("Alpha (D01 para. 2) and beta (D14 Part 1).");
    expect(first.index).to.be.lessThan(second.index);
  });

  it("returns nothing for text with no bundle references", () => {
    expect(parseCitations("The claimant must file a defence within 14 days.")).to.deep.equal([]);
    expect(parseCitations("")).to.deep.equal([]);
  });
});

describe("answer grounding — sentence splitting", () => {
  it("does not split after a citation abbreviation, which would orphan the locator", () => {
    const sentences = splitSentences("HSE considered that a material failing (D01 para. 13). The next point follows.");
    expect(sentences).to.have.length(2);
    expect(sentences[0].sentence).to.include("D01 para. 13");
  });

  it("does not split inside an unclosed bracket", () => {
    const sentences = splitSentences("The role was strategic (D07 para. 4 and D06 paras 1–2). Then this.");
    expect(sentences).to.have.length(2);
  });

  it("splits ordinary prose normally", () => {
    expect(splitSentences("One thing happened. Another thing happened; a third did too.")).to.have.length(3);
  });
});

describe("answer grounding — absence claims", () => {
  it("catches a disclaimer about the material the assistant was given", () => {
    const [claim] = parseAbsenceClaims(REAL.falseAbsence);
    expect(claim, "should detect the disclaimer").to.exist;
    expect(claim.citations[0].document).to.equal("D20");
  });

  it("catches a disclaimer that names no document, and leaves it unresolvable", () => {
    const [claim] = parseAbsenceClaims(REAL.absenceNoCitation);
    expect(claim).to.exist;
    expect(claim.citations).to.deep.equal([]);
    expect(classifyAbsence(claim, { inCase: {}, supplied: new Set() }).verdict).to.equal("UNRESOLVED");
  });

  it("ignores 'not supplied to <a third party>' — a direction about disclosure, not about our own access", () => {
    // This exact sentence appears in the graded answers; matching it would invent a defect.
    expect(parseAbsenceClaims(REAL.thirdPartyDisclosure)).to.deep.equal([]);
  });

  it("ignores an ordinary grounded sentence", () => {
    expect(parseAbsenceClaims(REAL.assertionWithRange)).to.deep.equal([]);
  });

  it("recognises the plural and inverted forms taken verbatim from the graded answers", () => {
    // Each of these was missed by the first pass and cost measured recall; they are kept here
    // exactly as the model wrote them so a future tidy-up of the patterns can't quietly drop them.
    for (const s of [
      "The facts relating to Mr Wieczorek, his earnings, household contributions and expected working life are not set out in the visible extracts.",
      "The full text of D10, D11, D13, D14, D19 and D20.2 is not reproduced in the available extracts.",
      "The bundle identifies a without-prejudice objection, but the available material does not set out the precise words said at the meeting.",
      "The exact wording of clause 4.7.4 is not included in the reproduced extract.",
      "That figure is not reproduced in the available D19 extract and should be verified.",
    ]) {
      expect(parseAbsenceClaims(s), s.slice(0, 60)).to.have.length(1);
    }
  });

  it("recognises the four constructions the grounding benchmark caught it missing", () => {
    for (const s of [
      // no noun for the supplied material at all
      "The complete paragraph is not reproduced here, so the formulation should be treated as provisional.",
      // auxiliary "been" between the negation and the participle
      "Those passages have not been reproduced in full, so I cannot characterise D06 further.",
      // plural subject, verb outside the original list
      "The present extracts do not provide the date of death.",
      // negation carried by "none"
      "There is no witness statement from the crane manufacturer, and none is reproduced in the material provided.",
    ]) {
      expect(parseAbsenceClaims(s), s.slice(0, 60)).to.have.length(1);
    }
  });

  it("still ignores a party's disclosure conduct after widening the patterns", () => {
    // Widening for "extracts do not provide" must not start matching "<party> has not provided".
    expect(parseAbsenceClaims("Meridian has not provided a disclosure protocol or certificate explaining the facilities used.")).to.deep.equal([]);
    expect(parseAbsenceClaims("Obtain all photographs not supplied to Dr Vantrease.")).to.deep.equal([]);
    expect(parseAbsenceClaims("The claimant did not provide the documents to the defence in time.")).to.deep.equal([]);
  });

  it("recognises the other phrasings the model reaches for", () => {
    for (const s of [
      "The lease is not before me, so the break clause cannot be assessed.",
      "I cannot see the sheriff's return in what was provided.",
      "The full text of that exhibit was not provided to me.",
      "No copy of the addendum is available.",
    ]) {
      expect(parseAbsenceClaims(s), s).to.have.length(1);
    }
  });
});

describe("answer grounding — cited assertions", () => {
  it("strips the bracketed reference so what gets checked reads as a claim", () => {
    const [a] = parseCitedAssertions(REAL.assertionWithParen);
    expect(a.assertion).to.not.include("D07");
    expect(a.assertion).to.include("denying responsibility for day-to-day site operations");
    expect(a.citations[0].document).to.equal("D07");
  });

  it("drops a bare list of references — there is no proposition to verify", () => {
    expect(parseCitedAssertions(REAL.citationList)).to.deep.equal([]);
  });

  it("ignores sentences with no reference at all", () => {
    expect(parseCitedAssertions("The concentration of safety roles was unusual.")).to.deep.equal([]);
  });
});

describe("answer grounding — bundle view", () => {
  it("maps a per-exhibit filename to its own label", () => {
    expect(documentLabelsFor("D14_Site_Daily_Log_Crane_Record_Delivery.pdf")).to.deep.equal(["D14"]);
  });

  it("expands a merged upload across the whole range it contains", () => {
    // The "new boost" case is one 745-chunk D01-D20_All.pdf; every label resolves to it.
    const labels = documentLabelsFor("D01-D20_All.pdf");
    expect(labels).to.have.length(20);
    expect(labels[0]).to.equal("D01");
    expect(labels[19]).to.equal("D20");
  });

  it("marks only the documents whose text actually reached the model as supplied", () => {
    const view = buildBundleView(
      [
        { id: "doc-14", name: "D14_Site_Daily_Log.pdf" },
        { id: "doc-20", name: "D20_Supplemental_Disclosure.pdf" },
      ],
      ["doc-14"],
    );
    expect(view.inCase).to.deep.equal({ D14: "doc-14", D20: "doc-20" });
    expect(view.supplied.has("D14")).to.equal(true);
    expect(view.supplied.has("D20")).to.equal(false);
  });
});

describe("answer grounding — the three-way absence verdict", () => {
  const view = buildBundleView(
    [
      { id: "doc-13", name: "D13_Exhibit_Access_Control.pdf" },
      { id: "doc-20", name: "D20_Supplemental_Disclosure.pdf" },
    ],
    ["doc-13"],
  );

  it("FALSE_ABSENCE when the model had the text and said it did not", () => {
    const [claim] = parseAbsenceClaims("D13 Part 4 is not reproduced in the material presently available.");
    expect(classifyAbsence(claim, view).verdict).to.equal("FALSE_ABSENCE");
  });

  it("NOT_SUPPLIED when the document exists but its text never reached the model", () => {
    const [claim] = parseAbsenceClaims("The passage at D20.1 para. 6 is not reproduced in the available extract.");
    const got = classifyAbsence(claim, view);
    expect(got.verdict).to.equal("NOT_SUPPLIED");
    expect(got.documentId).to.equal("doc-20");
  });

  it("CORRECT_ABSENCE when the document is genuinely not in the case", () => {
    const [claim] = parseAbsenceClaims("D19 is not reproduced in the supplied case context.");
    expect(classifyAbsence(claim, view).verdict).to.equal("CORRECT_ABSENCE");
  });

  it("takes the worst verdict when one sentence disclaims several documents", () => {
    const [claim] = parseAbsenceClaims("D13 Part 4 and D19 are not reproduced in the material presently available.");
    expect(claim.citations).to.have.length(2);
    expect(classifyAbsence(claim, view).verdict).to.equal("FALSE_ABSENCE");
  });

  it("does not blame the model for the inline cap: every label unsupplied means NOT_SUPPLIED, never FALSE_ABSENCE", () => {
    // The 21 Sep runs sent 3 ranked chunks of a 164k bundle; disclaimers were true for the turn.
    const capped = buildBundleView([{ id: "merged", name: "D01-D20_All.pdf" }], []);
    const [claim] = parseAbsenceClaims("The contract wording at D15 Part 2 is not reproduced in the available extract.");
    expect(classifyAbsence(claim, capped).verdict).to.equal("NOT_SUPPLIED");
  });
});

describe("answer grounding — scanAnswer", () => {
  it("counts verdicts and assertions over a whole answer", () => {
    const view = buildBundleView(
      [
        { id: "doc-07", name: "D07_Interview_Under_Caution.pdf" },
        { id: "doc-13", name: "D13_Exhibit_Access_Control.pdf" },
      ],
      ["doc-13"],
    );
    const answer = [
      REAL.assertionWithParen,
      "D13 Part 4 is not reproduced in the material presently available.",
      REAL.thirdPartyDisclosure,
      REAL.citationList,
    ].join(" ");
    const scan = scanAnswer(answer, view);
    expect(scan.counts.FALSE_ABSENCE).to.equal(1);
    expect(scan.counts.assertions).to.be.greaterThan(0);
    expect(scan.absenceClaims).to.have.length(1, "the third-party disclosure line is not an absence claim");
  });

  it("is safe on an empty or reference-free answer", () => {
    const empty = scanAnswer("", { inCase: {}, supplied: new Set() });
    expect(empty.counts.assertions).to.equal(0);
    expect(empty.counts.citations).to.equal(0);
    expect(empty.absenceClaims).to.deep.equal([]);
  });
});
