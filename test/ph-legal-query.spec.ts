import { expect } from "chai";
import { describe, it } from "mocha";
import { documentNumber, planPhSearch } from "../src/utils/ph-legal-query";

const RA = "REPUBLIC_ACT" as const;
const JURIS = "JURISPRUDENCE" as const;

describe("planPhSearch — Republic Acts", () => {
  it("leaves an ordinary query untouched (one local term, one remote call)", () => {
    expect(planPhSearch(RA, "violence against women")).to.deep.equal({
      kind: "search",
      localTerms: ["violence against women"],
      remoteQueries: ["violence against women"],
    });
  });

  it("expands an acronym to its RA number and never sends the acronym upstream", () => {
    const plan = planPhSearch(RA, "VAWC");
    expect(plan).to.include({ kind: "search" });
    if (plan.kind !== "search") throw new Error("unreachable");
    expect(plan.number).to.deep.equal({ field: "raNumber", digits: "9262" });
    expect(plan.remoteQueries).to.include.members(["Republic Act No. 9262", "R.A. No. 9262", "RA 9262"]);
    expect(plan.remoteQueries).to.include("Anti-Violence Against Women and Their Children Act of 2004");
    expect(plan.remoteQueries).to.not.include("VAWC");
  });

  it("ignores case, dots and spaces in an acronym", () => {
    for (const q of ["vawc", "V.A.W.C.", " Vawc "]) {
      const plan = planPhSearch(RA, q);
      expect(plan.kind === "search" && plan.number?.digits).to.equal("9262");
    }
    const rh = planPhSearch(RA, "RH Law");
    expect(rh.kind === "search" && rh.number?.digits).to.equal("10354");
  });

  it("maps IPRA to RA 8371 (not the intellectual-property results it used to return)", () => {
    const plan = planPhSearch(RA, "IPRA");
    expect(plan.kind === "search" && plan.number?.digits).to.equal("8371");
  });

  it("parses every way of typing an RA number to the same digits", () => {
    const forms = [
      "RA 9262", "R.A. 9262", "RA No. 9262", "R.A. No. 9262", "RA No.9262", "RA #9262", "RA# 9262", "RA9262",
      "Republic Act 9262", "Republic Act No. 9262", "Republic Act No.9262", "Republic Act #9262",
      "Republic Act Number 9262", "republic act no 9262", "Rep. Act No. 9262", "9262", "No. 9262", "#9262",
    ];
    for (const q of forms) {
      const plan = planPhSearch(RA, q);
      expect(plan.kind, q).to.equal("search");
      if (plan.kind === "search") {
        expect(plan.number, q).to.deep.equal({ field: "raNumber", digits: "9262" });
        expect(plan.remoteQueries, q).to.deep.equal(["Republic Act No. 9262", "R.A. No. 9262", "RA 9262"]);
      }
    }
  });

  it("does not treat a 1-2 digit bare number as a law", () => {
    expect(planPhSearch(RA, "12")).to.deep.equal({ kind: "search", localTerms: ["12"], remoteQueries: ["12"] });
  });

  it("only expands a whole-query acronym, not one inside a longer query", () => {
    expect(planPhSearch(RA, "vawc protection order")).to.deep.equal({
      kind: "search",
      localTerms: ["vawc protection order"],
      remoteQueries: ["vawc protection order"],
    });
  });
});

describe("planPhSearch — jurisprudence", () => {
  it("normalizes every way of typing a G.R. number", () => {
    const forms = [
      "G.R. No. 203335", "G.R. No.203335", "GR No. 203335", "GR No 203335", "G.R. 203335", "GR 203335",
      "GR# 203335", "GR#203335", "G.R. #203335", "GR203335", "G. R. No. 203335", "203335", "No. 203335", "#203335",
    ];
    for (const q of forms) {
      const plan = planPhSearch(JURIS, q);
      expect(plan.kind, q).to.equal("search");
      if (plan.kind === "search") {
        expect(plan.number, q).to.deep.equal({ field: "caseNumber", digits: "203335" });
        expect(plan.remoteQueries, q).to.deep.equal(["G.R. No. 203335", "203335"]);
      }
    }
  });

  it("keeps the L- prefix of older G.R. numbers in the upstream query", () => {
    const plan = planPhSearch(JURIS, "G.R. No. L-12345");
    expect(plan.kind === "search" && plan.remoteQueries).to.deep.equal(["G.R. No. L-12345", "L-12345"]);
  });

  it("searches cases that cite the act for an acronym or RA number, keeping the original query", () => {
    const plan = planPhSearch(JURIS, "VAWC");
    if (plan.kind !== "search") throw new Error("unreachable");
    expect(plan.number).to.equal(undefined);
    expect(plan.remoteQueries[0]).to.equal("VAWC");
    expect(plan.remoteQueries).to.include("Republic Act No. 9262");
    expect(plan.localTerms).to.include.members(["VAWC", "Republic Act No. 9262"]);

    const byNumber = planPhSearch(JURIS, "RA 9262");
    expect(byNumber.kind === "search" && byNumber.remoteQueries).to.include("Republic Act No. 9262");
  });

  it("leaves a case-name query untouched", () => {
    expect(planPhSearch(JURIS, "Disini v. Secretary of Justice")).to.deep.equal({
      kind: "search",
      localTerms: ["Disini v. Secretary of Justice"],
      remoteQueries: ["Disini v. Secretary of Justice"],
    });
  });
});

describe("planPhSearch — issuances juris.ph does not index", () => {
  const cases: Array<[string, string]> = [
    ["EO 209", "Executive Order No. 209"],
    ["E.O. No. 292", "Executive Order No. 292"],
    ["Executive Order No. 209", "Executive Order No. 209"],
    ["PD 442", "Presidential Decree No. 442"],
    ["P.D. No. 1529", "Presidential Decree No. 1529"],
    ["Presidential Decree #603", "Presidential Decree No. 603"],
    ["AO 25", "Administrative Order No. 25"],
    ["A.O. No. 25", "Administrative Order No. 25"],
    ["MO 32", "Memorandum Order No. 32"],
    ["Memorandum Order No. 32", "Memorandum Order No. 32"],
    ["Memorandum Circular 8", "Memorandum Circular No. 8"],
    ["BP 22", "Batas Pambansa Blg. 22"],
    ["B.P. Blg. 22", "Batas Pambansa Blg. 22"],
    ["Batas Pambansa Blg. 881", "Batas Pambansa Blg. 881"],
    ["CA 141", "Commonwealth Act No. 141"],
    ["Act No. 3815", "Act No. 3815"],
  ];
  for (const category of [RA, JURIS]) {
    for (const [q, label] of cases) {
      it(`${category}: "${q}" is recognised as ${label}`, () => {
        expect(planPhSearch(category, q)).to.deep.equal({ kind: "unindexed", label });
      });
    }
  }

  it("never reads 'PD 442' as Republic Act 442", () => {
    expect(planPhSearch(RA, "PD 442").kind).to.equal("unindexed");
  });

  it("still searches by name, e.g. 'Labor Code'", () => {
    expect(planPhSearch(RA, "Labor Code").kind).to.equal("search");
  });
});

describe("documentNumber", () => {
  it("compares document numbers on their first run of digits", () => {
    expect(documentNumber("G.R. No. 203335")).to.equal("203335");
    expect(documentNumber("RA 9262")).to.equal("9262");
    expect(documentNumber("No. 8371")).to.equal("8371");
    expect(documentNumber("R.A. No. 9208 (as amended by R.A. No. 10364)")).to.equal("9208");
    expect(documentNumber(null)).to.equal("");
  });
});
