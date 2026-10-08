import { expect } from "chai";
import { describe, it } from "mocha";
import { extractMissingEvidence } from "../src/utils/missing-evidence-parse";

describe("extractMissingEvidence", () => {
  it("returns undefined when there is no [MISSING_EVIDENCE] block at all", () => {
    expect(extractMissingEvidence("the bundle looks complete to me")).to.equal(undefined);
  });

  it("returns an empty array when the model read the bundle and found nothing unproven", () => {
    expect(extractMissingEvidence("[MISSING_EVIDENCE]\n[]\n[/MISSING_EVIDENCE]")).to.deep.equal([]);
  });

  it("parses a well-formed closed block", () => {
    const text = `[MISSING_EVIDENCE]
[{"label": "No signed copy of the 14 March variation", "detail": "Would establish the agreed rate change.", "suggestedSource": "The countersigned variation held by the contractor", "claim": "C2", "severity": "CRITICAL"}]
[/MISSING_EVIDENCE]`;
    expect(extractMissingEvidence(text)).to.deep.equal([
      {
        label: "No signed copy of the 14 March variation",
        detail: "Would establish the agreed rate change.",
        suggestedSource: "The countersigned variation held by the contractor",
        claimHandle: "C2",
        severity: "CRITICAL",
      },
    ]);
  });

  it("falls back to an open tag when the closing tag is missing (streaming cutoff)", () => {
    const text = `[MISSING_EVIDENCE]\n[{"label": "No delivery note for the 12 crates", "severity": "MINOR"}]`;
    const result = extractMissingEvidence(text);
    expect(result).to.have.length(1);
    expect(result![0].label).to.equal("No delivery note for the 12 crates");
    expect(result![0].severity).to.equal("MINOR");
  });

  it("defaults an invalid or missing severity to MODERATE rather than dropping the gap", () => {
    const text = `[MISSING_EVIDENCE][{"label": "No payroll certification"}, {"label": "No site diary", "severity": "CATASTROPHIC"}][/MISSING_EVIDENCE]`;
    const result = extractMissingEvidence(text);
    expect(result!.map((r) => r.severity)).to.deep.equal(["MODERATE", "MODERATE"]);
  });

  it("drops rows with no label — nothing to show or to match on a regeneration", () => {
    const text = `[MISSING_EVIDENCE][{"detail": "something is missing", "severity": "CRITICAL"}][/MISSING_EVIDENCE]`;
    expect(extractMissingEvidence(text)).to.deep.equal([]);
  });

  it("drops a repeated gap, ignoring case", () => {
    const text = `[MISSING_EVIDENCE][{"label": "No site diary"}, {"label": "no SITE diary"}][/MISSING_EVIDENCE]`;
    expect(extractMissingEvidence(text)).to.have.length(1);
  });

  it("normalises a bracketed or lower-case claim handle, and nulls a missing one", () => {
    const text = `[MISSING_EVIDENCE][{"label": "A"}, {"label": "B", "claim": "[c3]"}][/MISSING_EVIDENCE]`;
    const result = extractMissingEvidence(text);
    expect(result![0].claimHandle).to.equal(null);
    expect(result![1].claimHandle).to.equal("C3");
  });

  it("caps the batch at ten gaps", () => {
    const rows = Array.from({ length: 14 }, (_, i) => `{"label": "Gap ${i}"}`).join(",");
    expect(extractMissingEvidence(`[MISSING_EVIDENCE][${rows}][/MISSING_EVIDENCE]`)).to.have.length(10);
  });

  it("reads a block the model wrapped in a json code fence", () => {
    const text = '[MISSING_EVIDENCE]\n```json\n[{"label": "No handover certificate"}]\n```\n[/MISSING_EVIDENCE]';
    expect(extractMissingEvidence(text)!.map((r) => r.label)).to.deep.equal(["No handover certificate"]);
  });
});
