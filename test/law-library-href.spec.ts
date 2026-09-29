import { expect } from "chai";
import { describe, it } from "mocha";
import { lawLibraryHref } from "../src/utils/law-library-href";

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
