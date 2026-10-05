import { expect } from "chai";
import { describe, it } from "mocha";
import {
  damageCloseReason,
  findingCloseReason,
  matchRegeneratedFindings,
  newlyDoneNeedKeys,
} from "../src/utils/procedure-link";

describe("findingCloseReason", () => {
  it("closes when a finding moves into its category's fixed tag", () => {
    expect(findingCloseReason("WEAKNESS", "MATERIAL", "CLOSED")).to.equal("WEAKNESS_CLOSED");
    expect(findingCloseReason("ATTACK_STRATEGY", "BLOCKED", "READY")).to.equal("ATTACK_READY");
    expect(findingCloseReason("DEFENSE_STRATEGY", null, "ANSWERED")).to.equal("DEFENSE_ANSWERED");
    expect(findingCloseReason("LEGAL_ISSUE", "BRIEFING", "RESOLVED")).to.equal("ISSUE_RESOLVED");
  });

  it("does nothing for another tag, an unchanged tag, or a write that leaves the tag alone", () => {
    expect(findingCloseReason("WEAKNESS", "MATERIAL", "MINOR")).to.equal(null);
    expect(findingCloseReason("WEAKNESS", "CLOSED", "CLOSED")).to.equal(null);
    expect(findingCloseReason("WEAKNESS", "MATERIAL", undefined)).to.equal(null);
  });

  it("never closes a strength's to-do — a strength has no fixed state", () => {
    expect(findingCloseReason("STRENGTH", "MODERATE", "STRONG")).to.equal(null);
  });
});

describe("damageCloseReason", () => {
  it("closes once the entry is awarded or received, and only then", () => {
    expect(damageCloseReason({ done: false }, { done: true })).to.equal("DAMAGE_DONE");
    expect(damageCloseReason({ done: true }, { done: true })).to.equal(null);
    expect(damageCloseReason({ done: false }, { done: false })).to.equal(null);
    expect(damageCloseReason({ done: true }, { done: false })).to.equal(null);
  });
});

describe("newlyDoneNeedKeys", () => {
  it("returns only the needs ticked by this write", () => {
    expect(newlyDoneNeedKeys([{ key: "DOCUMENT" }], [{ key: "DOCUMENT" }, { key: "FACTOR_B" }])).to.deep.equal(["FACTOR_B"]);
    expect(newlyDoneNeedKeys([{ key: "DOCUMENT" }], [])).to.deep.equal([]);
  });
});

describe("matchRegeneratedFindings", () => {
  it("matches on category and label, ignoring case and stray spaces", () => {
    const moved = matchRegeneratedFindings(
      [
        { id: "old-1", category: "WEAKNESS", label: "No written protest" },
        { id: "old-2", category: "LEGAL_ISSUE", label: "No written protest" },
      ],
      [
        { id: "new-1", category: "WEAKNESS", label: " no written protest" },
        { id: "new-2", category: "STRENGTH", label: "No written protest" },
      ],
    );
    expect([...moved]).to.deep.equal([["old-1", "new-1"]]);
  });

  it("gives each new row to one old row only", () => {
    const moved = matchRegeneratedFindings(
      [
        { id: "old-1", category: "WEAKNESS", label: "Same" },
        { id: "old-2", category: "WEAKNESS", label: "Same" },
      ],
      [{ id: "new-1", category: "WEAKNESS", label: "Same" }],
    );
    expect([...moved]).to.deep.equal([["old-1", "new-1"]]);
  });
});
