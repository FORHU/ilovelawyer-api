import { expect } from "chai";
import { describe, it } from "mocha";
import { applyFloor, isUncertain, normalizeScore, readChoice } from "../src/utils/jev-common";
import { FINDING_TAGS_BY_CATEGORY, isTagAllowed } from "../src/constants";

const VERDICTS = ["SUPPORTED", "UNSUPPORTED", "CONTRADICTED"] as const;

describe("readChoice", () => {
  it("keeps a known answer", () => {
    expect(readChoice("SUPPORTED", VERDICTS, "UNSUPPORTED")).to.equal("SUPPORTED");
  });

  it("falls back on anything else", () => {
    expect(readChoice("MAYBE", VERDICTS, "UNSUPPORTED")).to.equal("UNSUPPORTED");
    expect(readChoice(undefined, VERDICTS, "UNSUPPORTED")).to.equal("UNSUPPORTED");
  });
});

describe("applyFloor", () => {
  it("downgrades the guarded verdict under the floor", () => {
    expect(applyFloor("CONTRADICTED", 0.69, "CONTRADICTED", 0.7, "UNSUPPORTED")).to.deep.equal({
      value: "UNSUPPORTED",
      downgraded: true,
    });
  });

  it("keeps the guarded verdict at or over the floor", () => {
    expect(applyFloor("CONTRADICTED", 0.7, "CONTRADICTED", 0.7, "UNSUPPORTED")).to.deep.equal({
      value: "CONTRADICTED",
      downgraded: false,
    });
  });

  it("never touches other verdicts, however unsure", () => {
    expect(applyFloor("SUPPORTED", 0.1, "CONTRADICTED", 0.7, "UNSUPPORTED").value).to.equal("SUPPORTED");
  });
});

describe("normalizeScore", () => {
  const levels = ["a", "b", "c", "d"];

  it("maps the levels onto 0..1", () => {
    expect(normalizeScore(0, levels)).to.equal(0);
    expect(normalizeScore(3, levels)).to.equal(1);
    expect(normalizeScore(1.5, levels)).to.equal(0.5);
  });

  it("clamps out-of-range scores", () => {
    expect(normalizeScore(-1, levels)).to.equal(0);
    expect(normalizeScore(9, levels)).to.equal(1);
  });
});

describe("isUncertain", () => {
  it("is true when any confidence is under 0.5", () => {
    expect(isUncertain(0.9, 0.49)).to.equal(true);
    expect(isUncertain(0.5, 0.9)).to.equal(false);
  });
});

describe("FINDING_TAGS_BY_CATEGORY", () => {
  it("only lets each category use its own tags", () => {
    expect(isTagAllowed("LEGAL_ISSUE", "CONTESTED")).to.equal(true);
    expect(isTagAllowed("LEGAL_ISSUE", "MATERIAL")).to.equal(false);
    expect(isTagAllowed("WEAKNESS", "CLOSED")).to.equal(true);
    expect(isTagAllowed("STRENGTH", "OPEN")).to.equal(false);
  });

  it("gives Attack and Defense Strategies no tags", () => {
    expect(FINDING_TAGS_BY_CATEGORY.ATTACK_STRATEGY).to.deep.equal([]);
    expect(FINDING_TAGS_BY_CATEGORY.DEFENSE_STRATEGY).to.deep.equal([]);
  });
});
