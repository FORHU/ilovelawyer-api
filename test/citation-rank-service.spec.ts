/** CitationRankSvc's pure parts: finding Library links in saved reply text, assembling what Jev reads
 * from a Law row, and deciding what is stored. The database and Jev paths are covered where they are
 * mocked (citation-rank.spec.ts); nothing here touches either. */
import { expect } from "chai";
import { describe, it } from "mocha";
import { extractLibraryLinks, lawText, LawLike, toAuthority, toItems } from "../src/services/citation-rank.service";
import { rankAuthority } from "../src/utils/citation-rank";

const law = (over: Partial<LawLike> = {}): LawLike => ({
  id: "uuid-1",
  jurisSourceId: "ph-123",
  category: "JURISPRUDENCE",
  title: "People v. Dela Cruz",
  year: 2011,
  division: "En Banc",
  sourceUrl: null,
  jurisUrl: "https://juris.ph/case/ph-123",
  summary: null,
  facts: null,
  disposition: null,
  courtReasoning: null,
  legalRulesCited: [],
  legalIssues: [],
  keyProvisions: [],
  ...over,
});

describe("extractLibraryLinks", () => {
  it("finds PH Library links and maps the wire category back to the Law category", () => {
    const text =
      "Quasi-delict is in [Civil Code Art. 2176 Law](/homepage/library/laws/ra-1?category=republic-acts) and [Pcl v. Bar](/homepage/library/laws/case-9?category=jurisprudence).";
    const links = extractLibraryLinks(text, "PH");
    expect(links.map((l) => [l.routeId, l.category, l.label])).to.deep.equal([
      ["ra-1", "REPUBLIC_ACT", "Civil Code Art. 2176"],
      ["case-9", "JURISPRUDENCE", "Pcl v. Bar"],
    ]);
  });
  it("uses the UK wire categories for a UK tenant, and ignores the PH ones", () => {
    const text = "[Act](/homepage/library/laws/u1?category=uk-legislation) [Case](/homepage/library/laws/u2?category=uk-case-law) [Wrong](/homepage/library/laws/u3?category=republic-acts)";
    expect(extractLibraryLinks(text, "UK").map((l) => [l.routeId, l.category])).to.deep.equal([
      ["u1", "REPUBLIC_ACT"],
      ["u2", "JURISPRUDENCE"],
    ]);
  });
  it("keeps a label that contains brackets, such as a neutral citation", () => {
    const [l] = extractLibraryLinks("[R v Misra [2004] EWCA Crim 2375 Jurisprudence](/homepage/library/laws/u2?category=uk-case-law)", "UK");
    expect(l.label).to.equal("R v Misra [2004] EWCA Crim 2375");
  });
  it("lists each href once, however many times it is cited, and decodes the id", () => {
    const text = "[A](/homepage/library/laws/a%20b?category=jurisprudence) again [A](/homepage/library/laws/a%20b?category=jurisprudence)";
    const links = extractLibraryLinks(text, "PH");
    expect(links).to.have.length(1);
    expect(links[0].routeId).to.equal("a b");
    expect(links[0].href).to.equal("/homepage/library/laws/a%20b?category=jurisprudence");
  });
  it("ignores external and ordinary links", () => {
    expect(extractLibraryLinks("[x](https://example.com/page) [y](/somewhere/else)", "PH")).to.deep.equal([]);
  });
});

describe("lawText", () => {
  it("puts the issues and rules before the long facts, and drops empty fields", () => {
    const t = lawText(law({ legalIssues: ["Is the driver liable?"], legalRulesCited: ["Civil Code Art. 2176"], facts: "A long set of facts." }));
    expect(t.split("\n")).to.deep.equal(["Issues: Is the driver liable?", "Rules cited: Civil Code Art. 2176", "A long set of facts."]);
  });
  it("is empty for a bare row", () => {
    expect(lawText(law())).to.equal("");
  });
});

describe("toAuthority", () => {
  const link = { href: "/h", routeId: "ph-123", category: "JURISPRUDENCE" as const, label: "People v. Dela Cruz" };
  it("carries the division, year and source url from the Law row", () => {
    const a = toAuthority(link, law());
    expect(a).to.include({ id: "/h", kind: "case", division: "En Banc", year: 2011, sourceUrl: "https://juris.ph/case/ph-123" });
  });
  it("treats a republic-act or UK legislation row as legislation", () => {
    expect(toAuthority({ ...link, category: "REPUBLIC_ACT" }, law({ category: "REPUBLIC_ACT" })).kind).to.equal("legislation");
  });
  it("still produces an authority when the Library row is missing, with no text", () => {
    const a = toAuthority(link, undefined);
    expect(a.text).to.equal(null);
    expect(a.label).to.equal("People v. Dela Cruz");
  });
});

describe("toItems", () => {
  it("never stores UNRATED, so absence means neutral", () => {
    const a = toAuthority({ href: "/h", routeId: "x", category: "JURISPRUDENCE", label: "Nobody v. Else" }, undefined);
    const results = [rankAuthority(a, "unrelated message", null)];
    expect(results[0].tier).to.equal("UNRATED");
    expect(toItems(results)).to.deep.equal([]);
  });
  it("stores a rated authority with its reason and whether the user named it", () => {
    const a = toAuthority({ href: "/h", routeId: "x", category: "JURISPRUDENCE", label: "Misra v. State" }, undefined);
    const [item] = toItems([rankAuthority(a, "What did Misra decide?", null)]);
    expect(item).to.deep.include({ href: "/h", tier: "HIGH", namedByUser: true });
    expect(item.reason).to.include("You named it");
  });
});
