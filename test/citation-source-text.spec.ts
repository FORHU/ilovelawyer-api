/** #364: fill in a citation's official text from the authority it resolved to, so the check has
 * something to compare against without the lawyer pasting it.
 *
 * Pure helpers (passage location, LegalDocML stripping, picking search words) are tested
 * directly; fetchOfficialText is tested with fake sources — no juris.ph, UK Legal MCP or DB.
 */
import { expect } from "chai";
import { describe, it } from "mocha";
import {
  locatePassage,
  stripLegalDocMl,
  distinctiveWords,
  fetchOfficialText,
  legislationWarnings,
  isRepealedSectionText,
  OfficialTextSources,
} from "../src/utils/citation-source-text";

const DECISION = [
  "This petition for review assails the decision of the Court of Appeals.",
  "",
  "The facts are undisputed. Respondent was hired as a sales supervisor in 2015 and was dismissed in 2019 after an audit.",
  "",
  "The employer may terminate the employee without notice where the employee has committed serious misconduct. The misconduct must relate to the performance of the employee's duties.",
  "",
  "WHEREFORE, the petition is DENIED.",
].join("\n");

describe("locatePassage — the part of a long source the quote is about", () => {
  it("finds the passage holding an exact quote, in the source's own words", () => {
    const passage = locatePassage(DECISION, "the employee has committed serious misconduct")!;
    expect(passage).to.include("The employer may terminate the employee without notice");
    expect(passage).to.not.include("WHEREFORE");
  });

  it("finds the passage a paraphrase is about", () => {
    const passage = locatePassage(DECISION, "An employer can dismiss a worker for grave misconduct without giving notice")!;
    expect(passage).to.include("serious misconduct");
  });

  it("stays within the size limit", () => {
    const long = Array.from({ length: 400 }, (_, i) => `Paragraph ${i} discusses unrelated procedural matters at length.`).join("\n\n") + "\n\n" + DECISION;
    const passage = locatePassage(long, "the employee has committed serious misconduct", 800)!;
    expect(passage.length).to.be.at.most(800);
    expect(passage).to.include("serious misconduct");
  });

  it("returns null when nothing in the source relates to the quote", () => {
    expect(locatePassage(DECISION, "Quantum meruit applies to maritime salvage claims")).to.equal(null);
  });
});

describe("stripLegalDocMl — a UK judgment paragraph as plain text", () => {
  it("drops the markup, keeps the paragraph number and decodes entities", () => {
    const xml =
      '<paragraph xmlns="http://docs.oasis-open.org/legaldocml/ns/akn/3.0" eId="para_1">\n\t  <num style="font-size:13pt">1.</num>\n\t  <content>\n\t    <p class="x">Ponzi schemes continue to draw in investors (&#8220;SIB&#8221;) &amp; others.</p>\n\t  </content>\n\t</paragraph>';
    expect(stripLegalDocMl(xml)).to.equal("1. Ponzi schemes continue to draw in investors (“SIB”) & others.");
  });
});

describe("distinctiveWords — what to search a judgment for when the quote isn't verbatim", () => {
  it("picks the quote's longest content words (ties in quote order), skipping negations and repeats", () => {
    expect(distinctiveWords("The bank was not negligent in executing the customer's payment instructions without verification", 3)).to.deep.equal([
      "instructions",
      "verification",
      "negligent",
    ]);
  });
});

function sources(overrides: Partial<OfficialTextSources> = {}): OfficialTextSources {
  return {
    law: async () => null,
    phFullText: async () => null,
    ukLegislationSection: async () => null,
    ukGrep: async () => [],
    ukParagraph: async () => null,
    ...overrides,
  };
}

const PH_LAW = { id: "law-ph", title: "Agabon v. NLRC", category: "JURISPRUDENCE", jurisSourceId: "ph-1", jurisUrl: "https://juris.ph/x" };
const UK_ACT = {
  id: "law-uk-act",
  title: "Equality Act 2010",
  category: "REPUBLIC_ACT",
  jurisSourceId: "https://www.legislation.gov.uk/ukpga/2010/15",
  jurisUrl: "https://www.legislation.gov.uk/ukpga/2010/15",
};
const UK_CASE = {
  id: "law-uk-case",
  title: "[2022] UKSC 34",
  category: "JURISPRUDENCE",
  jurisSourceId: "https://caselaw.nationalarchives.gov.uk/uksc/2022/34",
  jurisUrl: "https://caselaw.nationalarchives.gov.uk/uksc/2022/34",
};

describe("fetchOfficialText — where a resolved authority's text comes from", () => {
  it("PH: the decision's full text, narrowed to the passage", async () => {
    const result = await fetchOfficialText(
      { tenantCode: "PH", lawId: PH_LAW.id, quote: "the employee has committed serious misconduct" },
      sources({ law: async () => PH_LAW, phFullText: async () => DECISION }),
    );
    expect(result).to.include({ source: "PH_LAW", ref: null, label: "Agabon v. NLRC" });
    expect(result!.text).to.include("serious misconduct");
    expect(result!.text).to.not.include("WHEREFORE");
  });

  it("UK legislation: the cited section's text", async () => {
    let asked: unknown;
    const result = await fetchOfficialText(
      { tenantCode: "UK", lawId: UK_ACT.id, quote: "A person discriminates against another", ukSection: "13" },
      sources({
        law: async () => UK_ACT,
        ukLegislationSection: async (args) => {
          asked = args;
          return {
            content: "(1) A person (A) discriminates against another (B) if, because of a protected characteristic, A treats B less favourably than A treats or would treat others.",
            inForce: null,
            extent: ["England", "Wales", "Scotland"],
          };
        },
      }),
    );
    expect(asked).to.deep.equal({ type: "ukpga", year: 2010, number: 15, section: "13" });
    expect(result).to.include({ source: "UK_LEGISLATION", ref: "s. 13", label: "Equality Act 2010, s. 13" });
    expect(result!.text).to.include("discriminates against another");
    expect(result!.legislation).to.deep.equal({ inForce: null, extent: ["England", "Wales", "Scotland"] });
  });

  it("UK legislation without a section: nothing to fetch", async () => {
    const result = await fetchOfficialText(
      { tenantCode: "UK", lawId: UK_ACT.id, quote: "A person discriminates against another" },
      sources({ law: async () => UK_ACT, ukLegislationSection: async () => ({ content: "should not be called", inForce: null, extent: [] }) }),
    );
    expect(result).to.equal(null);
  });

  it("UK judgment: a verbatim quote is found directly, and its paragraph fetched in full", async () => {
    const greps: string[] = [];
    const result = await fetchOfficialText(
      { tenantCode: "UK", lawId: UK_CASE.id, quote: "has reasonable grounds for believing" },
      sources({
        law: async () => UK_CASE,
        ukGrep: async (_slug, pattern) => {
          greps.push(pattern);
          return [{ eId: "para_37" }];
        },
        ukParagraph: async (slug, eId) => `<paragraph eId="${eId}"><num>37.</num><p>A bank has reasonable grounds for believing the payment is a fraud (${slug}).</p></paragraph>`,
      }),
    );
    expect(greps).to.have.length(1);
    expect(result).to.include({ source: "UK_JUDGMENT", ref: "para_37", pinpoint: "para. 37", label: "[2022] UKSC 34, para. 37" });
    expect(result!.text).to.equal("37. A bank has reasonable grounds for believing the payment is a fraud (uksc/2022/34).");
  });

  it("UK judgment: a paraphrase is located by its distinctive words, taking the paragraph most of them hit", async () => {
    const result = await fetchOfficialText(
      { tenantCode: "UK", lawId: UK_CASE.id, quote: "A bank owes a duty to refuse payment instructions it believes fraudulent" },
      sources({
        law: async () => UK_CASE,
        ukGrep: async (_slug, pattern) => {
          if (pattern.includes(" ")) return []; // the verbatim search misses
          if (pattern === "instructions") return [{ eId: "para_37" }, { eId: "para_90" }];
          if (pattern === "fraudulent") return [{ eId: "para_37" }];
          return [{ eId: "para_12" }];
        },
        ukParagraph: async (_slug, eId) => `<paragraph><num>${eId.replace("para_", "")}.</num><p>Text of ${eId}.</p></paragraph>`,
      }),
    );
    expect(result).to.include({ ref: "para_37", pinpoint: "para. 37" });
  });

  it("gives up after the time limit rather than holding the check", async () => {
    const result = await fetchOfficialText(
      { tenantCode: "PH", lawId: PH_LAW.id, quote: "the employee has committed serious misconduct" },
      sources({ law: async () => PH_LAW, phFullText: () => new Promise((resolve) => setTimeout(() => resolve(DECISION), 200)) }),
      50,
    );
    expect(result).to.equal(null);
  });

  it("a failing source gives no text rather than an error", async () => {
    const result = await fetchOfficialText(
      { tenantCode: "PH", lawId: PH_LAW.id, quote: "the employee has committed serious misconduct" },
      sources({
        law: async () => PH_LAW,
        phFullText: async () => {
          throw new Error("juris.ph down");
        },
      }),
    );
    expect(result).to.equal(null);
  });

  it("no resolved authority: nothing to fetch", async () => {
    expect(await fetchOfficialText({ tenantCode: "PH", lawId: "missing", quote: "anything at all here" }, sources())).to.equal(null);
  });
});

describe("legislationWarnings — #365: a UK section that isn't in force, or doesn't reach the case", () => {
  it("warns when the section isn't in force", () => {
    expect(legislationWarnings({ inForce: false, extent: ["England", "Wales"] }, "England and Wales").map((w) => w.code)).to.deep.equal(["NOT_IN_FORCE"]);
  });

  it("warns when the section doesn't extend to the case's legal system", () => {
    const [warning] = legislationWarnings({ inForce: null, extent: ["England", "Wales"] }, "Scotland");
    expect(warning.code).to.equal("OUTSIDE_EXTENT");
    expect(warning.message).to.equal("It doesn't extend to Scotland (it extends to England and Wales).");
  });

  it("an England-only section still reaches an England and Wales case", () => {
    expect(legislationWarnings({ inForce: null, extent: ["England"] }, "England and Wales")).to.deep.equal([]);
  });

  it("reads legislation.gov.uk's short codes too", () => {
    expect(legislationWarnings({ inForce: null, extent: ["E", "W", "S"] }, "Northern Ireland").map((w) => w.code)).to.deep.equal(["OUTSIDE_EXTENT"]);
    expect(legislationWarnings({ inForce: null, extent: ["E+W+S+N.I."] }, "Northern Ireland")).to.deep.equal([]);
  });

  it("says nothing when it doesn't know: in force unknown, no extent, or no legal system set on the case", () => {
    expect(legislationWarnings({ inForce: null, extent: [] }, "Scotland")).to.deep.equal([]);
    expect(legislationWarnings({ inForce: null, extent: ["England", "Wales"] }, null)).to.deep.equal([]);
  });

  it("both at once", () => {
    expect(legislationWarnings({ inForce: false, extent: ["Scotland"] }, "England and Wales").map((w) => w.code)).to.deep.equal(["NOT_IN_FORCE", "OUTSIDE_EXTENT"]);
  });
});

describe("isRepealedSectionText — legislation.gov.uk shows a wholly repealed section as dots", () => {
  it("heading, section number, then only dots: repealed", () => {
    expect(isRepealedSectionText("Mode of forming incorporated company. 1 . . . . . . . . . . . . . . . .", "1")).to.equal(true);
    expect(isRepealedSectionText("A company’s capacity not limited by its memorandum. 35 . . . . . . . . .", "35")).to.equal(true);
  });

  it("a section with text is not", () => {
    expect(isRepealedSectionText("Direct discrimination 13 1 A person (A) discriminates against another (B) if, because of a protected characteristic.", "13")).to.equal(false);
  });

  it("one repealed subsection doesn't make the whole section repealed", () => {
    expect(isRepealedSectionText("Direct discrimination 13 1 A person (A) discriminates against another (B). 2 . . . . . . . .", "13")).to.equal(false);
  });
});

describe("fetchOfficialText — a wholly repealed UK section (#365)", () => {
  it("reports it not in force, and offers no text to check against", async () => {
    const result = await fetchOfficialText(
      { tenantCode: "UK", lawId: "law-ca", quote: "Any two or more persons associated for a lawful purpose may form an incorporated company", ukSection: "1" },
      sources({
        law: async () => ({ ...UK_ACT, title: "Companies Act 1985", jurisSourceId: "https://www.legislation.gov.uk/ukpga/1985/6" }),
        ukLegislationSection: async () => ({ content: "Mode of forming incorporated company. 1 . . . . . . . . . .", inForce: null, extent: ["England", "Wales", "Scotland"] }),
      }),
    );
    expect(result!.legislation).to.deep.equal({ inForce: false, extent: ["England", "Wales", "Scotland"] });
    expect(result!.text).to.equal("");
  });
});
