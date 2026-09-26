import { expect } from "chai";
import { describe, it } from "mocha";
import { ALLEGATION_PHRASED_NOTE, deriveEventStatus, outcomeForPhrasing, SUPPORT_MIN_CONFIDENCE } from "../src/utils/reconstruction-event-status";

const sure = (verdict: "SUPPORTED" | "UNSUPPORTED" | "CONTRADICTED", evidenceKind: "SHOWN_BY_DOCUMENT" | "ESTABLISHED" | "ASSERTED_BY_PARTY" | "STATED_BY_WITNESS", confidence = 0.95) => ({ verdict, evidenceKind, confidence });

describe("deriveEventStatus", () => {
  it("maps a contradiction to Disputed and an unsupported event to Unverified", () => {
    expect(deriveEventStatus(sure("CONTRADICTED", "SHOWN_BY_DOCUMENT"))).to.equal("DISPUTED");
    expect(deriveEventStatus(sure("UNSUPPORTED", "SHOWN_BY_DOCUMENT"))).to.equal("UNVERIFIED");
  });

  it("verifies what a document shows or a finding establishes", () => {
    expect(deriveEventStatus(sure("SUPPORTED", "SHOWN_BY_DOCUMENT"))).to.equal("VERIFIED");
    expect(deriveEventStatus(sure("SUPPORTED", "ESTABLISHED"))).to.equal("VERIFIED");
  });

  it("does not call a claim disputed just because only one party makes it", () => {
    // Doe's start date: her affidavit says so, nothing else mentions it, nobody contests it.
    expect(deriveEventStatus(sure("SUPPORTED", "ASSERTED_BY_PARTY"))).to.equal("UNVERIFIED");
    expect(deriveEventStatus(sure("SUPPORTED", "ASSERTED_BY_PARTY"), {})).to.equal("UNVERIFIED");
  });

  it("only ever returns DISPUTED for a conflict", () => {
    const checks = (["SUPPORTED", "UNSUPPORTED"] as const).flatMap((v) =>
      (["SHOWN_BY_DOCUMENT", "ESTABLISHED", "ASSERTED_BY_PARTY", "STATED_BY_WITNESS"] as const).flatMap((k) => [sure(v, k), sure(v, k, 0.2)]),
    );
    for (const c of checks) {
      for (const corroborated of [false, true]) expect(deriveEventStatus(c, { corroborated }), JSON.stringify([c, corroborated])).to.not.equal("DISPUTED");
    }
    expect(deriveEventStatus(sure("CONTRADICTED", "SHOWN_BY_DOCUMENT"))).to.equal("DISPUTED");
    expect(deriveEventStatus(sure("SUPPORTED", "SHOWN_BY_DOCUMENT"), { contradicted: true })).to.equal("DISPUTED");
  });

  it("does not badge an event on a SUPPORTED the model was unsure of", () => {
    // The first end-to-end run: "paid for 8.0 hours" came out Verified on a 24% SUPPORTED.
    for (const kind of ["SHOWN_BY_DOCUMENT", "ESTABLISHED", "ASSERTED_BY_PARTY", "STATED_BY_WITNESS"] as const) {
      expect(deriveEventStatus(sure("SUPPORTED", kind, 0.24)), kind).to.equal("UNVERIFIED");
    }
    expect(deriveEventStatus(sure("SUPPORTED", "SHOWN_BY_DOCUMENT", SUPPORT_MIN_CONFIDENCE))).to.equal("VERIFIED");
  });

  it("leaves a lone witness account Unverified until something corroborates it", () => {
    const witness = sure("SUPPORTED", "STATED_BY_WITNESS");
    expect(deriveEventStatus(witness)).to.equal("UNVERIFIED");
    expect(deriveEventStatus(witness, { corroborated: true })).to.equal("VERIFIED");
  });

  it("lets an independent document settle a party's own assertion", () => {
    const party = sure("SUPPORTED", "ASSERTED_BY_PARTY");
    expect(deriveEventStatus(party, { corroborated: true })).to.equal("VERIFIED");
  });

  it("lets a contradiction in another document overturn anything its own source supports", () => {
    // The employer's letter says AWOL; the payroll beside it says otherwise.
    for (const kind of ["SHOWN_BY_DOCUMENT", "ESTABLISHED", "ASSERTED_BY_PARTY", "STATED_BY_WITNESS"] as const) {
      expect(deriveEventStatus(sure("SUPPORTED", kind), { contradicted: true }), kind).to.equal("DISPUTED");
    }
    expect(deriveEventStatus(sure("SUPPORTED", "ASSERTED_BY_PARTY"), { contradicted: true, corroborated: true })).to.equal("DISPUTED");
  });
});

describe("outcomeForPhrasing", () => {
  it("flags an allegation as Unverified with a note, and lets a fact through to the source check", () => {
    expect(outcomeForPhrasing("ALLEGATION")).to.deep.equal({ status: "UNVERIFIED", statusNote: ALLEGATION_PHRASED_NOTE });
    expect(outcomeForPhrasing("FACT")).to.equal(null);
  });
});
