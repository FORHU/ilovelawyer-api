import { expect } from "chai";
import { describe, it } from "mocha";
import { lawLibraryHref, legislationSection, libraryHref } from "../src/utils/law-library-href";

const law = { id: "law-uuid-1", jurisSourceId: "juris-uuid-9", category: "JURISPRUDENCE" as const };

describe("lawLibraryHref", () => {
  it("keys a PH law on its juris.ph id, with the PH category", () => {
    expect(lawLibraryHref("PH", law)).to.equal("/homepage/library/laws/juris-uuid-9?category=jurisprudence");
    expect(lawLibraryHref("PH", { ...law, category: "REPUBLIC_ACT" })).to.equal("/homepage/library/laws/juris-uuid-9?category=republic-acts");
  });

  it("keys a UK law on Law.id, with the UK category", () => {
    expect(lawLibraryHref("UK", law)).to.equal("/homepage/library/laws/law-uuid-1?category=uk-case-law");
    expect(lawLibraryHref("UK", { ...law, category: "REPUBLIC_ACT" })).to.equal("/homepage/library/laws/law-uuid-1?category=uk-legislation");
  });
});

describe("libraryHref section pinpoint", () => {
  it("appends the cited section, so different sections of one Act open different places", () => {
    expect(libraryHref("UK", "act-1", "REPUBLIC_ACT", "49")).to.equal("/homepage/library/laws/act-1?category=uk-legislation&section=49");
    expect(libraryHref("UK", "act-1", "REPUBLIC_ACT")).to.equal("/homepage/library/laws/act-1?category=uk-legislation");
  });
});

describe("legislationSection", () => {
  it("reads the section from a legislation.gov.uk URL first", () => {
    expect(legislationSection("https://www.legislation.gov.uk/ukpga/2015/15/section/54", "Consumer Rights Act 2015")).to.equal("54");
  });

  it("falls back to the label", () => {
    expect(legislationSection("https://www.legislation.gov.uk/ukpga/2015/15", "Consumer Rights Act 2015, s 49")).to.equal("49");
    expect(legislationSection("https://www.legislation.gov.uk/ukpga/2015/15", "section 21A of the Act")).to.equal("21A");
    expect(legislationSection("https://www.legislation.gov.uk/ukpga/2015/15", "Consumer Rights Act 2015")).to.equal(null);
  });
});
