import { expect } from "chai";
import { describe, it } from "mocha";
import { planUkLegislationQuery, preferExactRef, preferExactLocalRef } from "../src/legal/law-source/uk/uk-legal-query";

describe("planUkLegislationQuery", () => {
  it("leaves an ordinary query untouched", () => {
    expect(planUkLegislationQuery("data protection obligations for schools")).to.deep.equal({
      kind: "plain",
      query: "data protection obligations for schools",
    });
  });

  it("expands HRA to its full title", () => {
    const plan = planUkLegislationQuery("HRA");
    expect(plan).to.deep.equal({
      kind: "alias",
      query: "Human Rights Act 1998",
      ref: { type: "ukpga", year: 1998, number: 42 },
    });
  });

  it("ignores case and punctuation", () => {
    for (const q of ["hra", "H.R.A.", " Hra "]) {
      const plan = planUkLegislationQuery(q);
      expect(plan.kind, q).to.equal("alias");
      expect(plan.query, q).to.equal("Human Rights Act 1998");
    }
  });

  it("resolves every verified alias", () => {
    const expected: Record<string, string> = {
      PACE: "Police and Criminal Evidence Act 1984",
      FOIA: "Freedom of Information Act 2000",
      DPA: "Data Protection Act 2018",
      TUPE: "The Transfer of Undertakings (Protection of Employment) Regulations 2006",
      IHTA: "Inheritance Tax Act 1984",
      MHA: "Mental Health Act 1983",
      EA: "Equality Act 2010",
      SGA: "Sale of Goods Act 1979",
      CRA: "Consumer Rights Act 2015",
      LPA: "Law of Property Act 1925",
      ERA: "Employment Rights Act 1996",
      CDPA: "Copyright, Designs and Patents Act 1988",
      POCA: "Proceeds of Crime Act 2002",
      RIPA: "Regulation of Investigatory Powers Act 2000",
      CCA: "Consumer Credit Act 1974",
      LASPO: "Legal Aid, Sentencing and Punishment of Offenders Act 2012",
      FSMA: "Financial Services and Markets Act 2000",
      MCA: "Mental Capacity Act 2005",
      SOA: "Sexual Offences Act 2003",
    };
    for (const [acronym, title] of Object.entries(expected)) {
      const plan = planUkLegislationQuery(acronym);
      expect(plan.kind, acronym).to.equal("alias");
      expect(plan.query, acronym).to.equal(title);
    }
  });

  it("only expands a whole-query acronym", () => {
    expect(planUkLegislationQuery("HRA damages claim")).to.deep.equal({
      kind: "plain",
      query: "HRA damages claim",
    });
  });

  it("handles an empty query", () => {
    expect(planUkLegislationQuery("")).to.deep.equal({ kind: "plain", query: "" });
  });
});

describe("preferExactRef (juris.ph-style hits: type/year/number)", () => {
  const ref = { type: "ukpga", year: 2010, number: 15 };

  it("moves the exact document to the front", () => {
    const rows = [
      { id: "amend", type: "ukpga", year: 2023, number: 51 },
      { id: "ea2010", type: "ukpga", year: 2010, number: 15 },
    ];
    expect(preferExactRef(rows, ref).map((r) => r.id)).to.deep.equal(["ea2010", "amend"]);
  });

  it("leaves the order unchanged when the exact document is absent", () => {
    const rows = [{ id: "other", type: "ukpga", year: 1999, number: 1 }];
    expect(preferExactRef(rows, ref)).to.deep.equal(rows);
  });

  it("leaves the order unchanged when it is already first", () => {
    const rows = [{ id: "hra", type: "ukpga", year: 1998, number: 42 }];
    expect(preferExactRef(rows, { type: "ukpga", year: 1998, number: 42 })).to.deep.equal(rows);
  });

  it("handles an empty list", () => {
    expect(preferExactRef([], ref)).to.deep.equal([]);
  });
});

describe("preferExactLocalRef (stored Law rows: raNumber/year)", () => {
  const ref = { type: "ukpga", year: 2010, number: 15 };

  it("moves the row with the matching raNumber and year to the front", () => {
    const rows = [
      { id: "amend", raNumber: "51", year: 2023 },
      { id: "ea2010", raNumber: "15", year: 2010 },
    ];
    expect(preferExactLocalRef(rows, ref).map((r) => r.id)).to.deep.equal(["ea2010", "amend"]);
  });

  it("leaves the order unchanged when no stored row matches", () => {
    const rows = [{ id: "other", raNumber: "1", year: 1999 }];
    expect(preferExactLocalRef(rows, ref)).to.deep.equal(rows);
  });

  it("requires both raNumber and year to match (same number, different year)", () => {
    const rows = [{ id: "wrong-year", raNumber: "15", year: 1999 }];
    expect(preferExactLocalRef(rows, ref)).to.deep.equal(rows);
  });
});
