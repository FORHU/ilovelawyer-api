import { expect } from "chai";
import { describe, it } from "mocha";
import { applyOutlookGuards, parseCaseOutlook, ParsedCaseOutlook } from "../src/utils/case-outlook-parse";
import { OUTLOOK_LOW_CONFIDENCE_RISK_SEVERITIES, OUTLOOK_MIN_READY_DOCS } from "../src/constants";

describe("parseCaseOutlook", () => {
  it("parses a well-formed [CASE_OUTLOOK] block", () => {
    const text = `[CASE_OUTLOOK]
{"band": "LEANS_FAVORABLE", "confidence": "MEDIUM", "rationale": "The signed contract supports the claim.",
"drivers": [{"label": "Signed contract", "direction": "HELPS", "sourceDocId": "doc-1"}, {"label": "Late notice", "direction": "HURTS"}]}
[/CASE_OUTLOOK]`;
    expect(parseCaseOutlook(text)).to.deep.equal({
      band: "LEANS_FAVORABLE",
      confidence: "MEDIUM",
      rationale: "The signed contract supports the claim.",
      drivers: [
        { label: "Signed contract", direction: "HELPS", sourceDocId: "doc-1" },
        { label: "Late notice", direction: "HURTS" },
      ],
    });
  });

  it("parses JSON wrapped in prose and a ```json fence, with no tag", () => {
    const text = 'Here is my assessment:\n```json\n{"band": "UNCERTAIN", "confidence": "LOW", "rationale": "Mixed {signals}."}\n```\nLet me know.';
    const parsed = parseCaseOutlook(text);
    expect(parsed).to.include({ band: "UNCERTAIN", confidence: "LOW", rationale: "Mixed {signals}." });
    expect(parsed!.drivers).to.deep.equal([]);
  });

  it("parses bare JSON surrounded by prose", () => {
    const parsed = parseCaseOutlook('Sure. {"band": "UNFAVORABLE", "confidence": "HIGH", "rationale": "No evidence of payment."} Hope that helps.');
    expect(parsed).to.include({ band: "UNFAVORABLE", confidence: "HIGH" });
  });

  it("parses a tag left open by a cutoff", () => {
    const parsed = parseCaseOutlook('[CASE_OUTLOOK]{"band": "FAVORABLE", "confidence": "HIGH", "rationale": "Strong."}');
    expect(parsed).to.include({ band: "FAVORABLE" });
  });

  it("normalizes spacing, case and British spelling of an allowed band", () => {
    const parsed = parseCaseOutlook('{"band": "leans favourable", "confidence": "medium", "rationale": "x"}');
    expect(parsed).to.include({ band: "LEANS_FAVORABLE", confidence: "MEDIUM" });
  });

  it("rejects an unknown band rather than guessing a neighbour", () => {
    expect(parseCaseOutlook('{"band": "WINNING", "confidence": "HIGH", "rationale": "x"}')).to.be.undefined;
  });

  it("rejects an unknown or missing confidence", () => {
    expect(parseCaseOutlook('{"band": "FAVORABLE", "confidence": "VERY_HIGH", "rationale": "x"}')).to.be.undefined;
    expect(parseCaseOutlook('{"band": "FAVORABLE", "rationale": "x"}')).to.be.undefined;
  });

  it("rejects a missing rationale", () => {
    expect(parseCaseOutlook('{"band": "FAVORABLE", "confidence": "HIGH"}')).to.be.undefined;
  });

  it("returns undefined when there is no JSON at all", () => {
    expect(parseCaseOutlook("I cannot assess this case.")).to.be.undefined;
  });

  it("ignores any numeric score or probability the model volunteers", () => {
    const parsed = parseCaseOutlook('{"band": "FAVORABLE", "confidence": "HIGH", "rationale": "x", "score": 72, "probability": 0.8}');
    expect(parsed).to.have.all.keys("band", "confidence", "rationale", "drivers");
  });

  it("drops drivers with a missing label or an invalid direction", () => {
    const parsed = parseCaseOutlook(
      '{"band": "FAVORABLE", "confidence": "HIGH", "rationale": "x", "drivers": [{"label": "ok", "direction": "HELPS"}, {"label": "bad", "direction": "MAYBE"}, {"direction": "HURTS"}]}',
    );
    expect(parsed!.drivers).to.deep.equal([{ label: "ok", direction: "HELPS" }]);
  });
});

describe("applyOutlookGuards", () => {
  const outlook: ParsedCaseOutlook = {
    band: "LEANS_FAVORABLE",
    confidence: "HIGH",
    rationale: "x",
    drivers: [
      { label: "Real doc", direction: "HELPS", sourceDocId: "doc-1" },
      { label: "Invented doc", direction: "HURTS", sourceDocId: "doc-999" },
      { label: "No doc", direction: "HURTS" },
    ],
  };
  const base = {
    caseDocumentIds: ["doc-1", "doc-2", "doc-3"],
    readyDocumentCount: 3,
    openRiskSeverities: [] as ("FATAL" | "MAJOR" | "UNVERIFIED" | "MISSING_EVIDENCE" | "DEADLINE")[],
    minReadyDocs: OUTLOOK_MIN_READY_DOCS,
    lowConfidenceRiskSeverities: OUTLOOK_LOW_CONFIDENCE_RISK_SEVERITIES,
  };

  it("drops a driver's sourceDocId that isn't on the case but keeps the driver", () => {
    const guarded = applyOutlookGuards(outlook, base);
    expect(guarded.drivers).to.deep.equal([
      { label: "Real doc", direction: "HELPS", sourceDocId: "doc-1" },
      { label: "Invented doc", direction: "HURTS" },
      { label: "No doc", direction: "HURTS" },
    ]);
  });

  it("keeps the model's confidence when the evidence is not thin", () => {
    expect(applyOutlookGuards(outlook, { ...base, openRiskSeverities: ["MAJOR", "DEADLINE"] }).confidence).to.equal("HIGH");
  });

  it("caps confidence to LOW with fewer READY documents than the minimum", () => {
    expect(applyOutlookGuards(outlook, { ...base, readyDocumentCount: OUTLOOK_MIN_READY_DOCS - 1 }).confidence).to.equal("LOW");
  });

  it("caps confidence to LOW with an open FATAL or MISSING_EVIDENCE risk", () => {
    expect(applyOutlookGuards(outlook, { ...base, openRiskSeverities: ["FATAL"] }).confidence).to.equal("LOW");
    expect(applyOutlookGuards(outlook, { ...base, openRiskSeverities: ["MISSING_EVIDENCE"] }).confidence).to.equal("LOW");
  });

  it("leaves the band alone when capping confidence", () => {
    expect(applyOutlookGuards(outlook, { ...base, readyDocumentCount: 1 }).band).to.equal("LEANS_FAVORABLE");
  });
});
