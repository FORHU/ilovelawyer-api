import { expect } from "chai";
import { describe, it } from "mocha";
import { mergeNeedsDone, parseNeedsDone } from "../src/utils/witness-needs";
import { toStoredMatch } from "../src/utils/witness-need-proof-jev";

describe("needs done proof", () => {
  const docs = new Set(["d1", "d2"]);
  const now = new Date("2026-09-25T10:00:00Z");

  it("stamps who and when on a new tick and keeps the proof document", () => {
    const { done, rejected } = mergeNeedsDone(null, [{ key: "FACTOR_E", documentId: "d1", note: " bank replied " }], docs, "u1", now);
    expect(rejected).to.deep.equal([]);
    expect(done).to.deep.equal([{ key: "FACTOR_E", documentId: "d1", note: "bank replied", by: "u1", at: now.toISOString() }]);
  });

  it("rejects a tick whose document is not in this case", () => {
    const { done, rejected } = mergeNeedsDone(null, [{ key: "STATEMENT", documentId: "other-case-doc" }], docs, "u1", now);
    expect(done).to.deep.equal([]);
    expect(rejected).to.deep.equal(["STATEMENT"]);
  });

  it("keeps the original who and when when nothing about a tick changed", () => {
    const stored = [{ key: "FACTOR_C", documentId: "d1", by: "u9", at: "2026-09-24T09:00:00.000Z" }];
    const { done } = mergeNeedsDone(stored, [{ key: "FACTOR_C", documentId: "d1" }], docs, "u1", now);
    expect(done[0].by).to.equal("u9");
    expect(done[0].at).to.equal("2026-09-24T09:00:00.000Z");
  });

  it("re-stamps a tick when its proof document changes, and drops unticked items", () => {
    const stored = [
      { key: "FACTOR_C", documentId: "d1", by: "u9", at: "t" },
      { key: "FACTOR_E", documentId: "d1", by: "u9", at: "t" },
    ];
    const { done } = mergeNeedsDone(stored, [{ key: "FACTOR_C", documentId: "d2" }], docs, "u1", now);
    expect(done).to.have.length(1);
    expect(done[0]).to.include({ key: "FACTOR_C", documentId: "d2", by: "u1" });
  });

  it("does not count old bare-key ticks, which had no proof", () => {
    expect(parseNeedsDone(["FACTOR_A", "STATEMENT"])).to.deep.equal([]);
    expect(parseNeedsDone(null)).to.deep.equal([]);
  });
});

describe("proof match policy", () => {
  it("refuses any mismatch, however unsure Jev was", () => {
    expect(toStoredMatch({ verdict: "DOES_NOT_SATISFY", confidence: 0.9 })).to.equal("REFUSE");
    expect(toStoredMatch({ verdict: "DOES_NOT_SATISFY", confidence: 0.3 })).to.equal("REFUSE");
  });

  it("stores a match, a partial fit and an unreadable file as they are", () => {
    expect(toStoredMatch({ verdict: "SATISFIES", confidence: 0.8 })).to.deep.equal({ verdict: "SATISFIES", confidence: 0.8 });
    expect(toStoredMatch({ verdict: "PARTLY", confidence: 0.7 })).to.deep.equal({ verdict: "PARTLY", confidence: 0.7 });
    expect(toStoredMatch({ verdict: "CANNOT_TELL", confidence: 1 })).to.deep.equal({ verdict: "CANNOT_TELL", confidence: 1 });
  });

  it("keeps the match on a stored tick and reads it back", () => {
    const now = new Date("2026-09-25T10:00:00Z");
    const m = new Map([["FACTOR_E", { verdict: "SATISFIES" as const, confidence: 0.9 }]]);
    const { done } = mergeNeedsDone(null, [{ key: "FACTOR_E", documentId: "d1" }], new Set(["d1"]), "u1", now, m);
    expect(done[0].match).to.deep.equal({ verdict: "SATISFIES", confidence: 0.9 });
    expect(parseNeedsDone(done)[0].match).to.deep.equal({ verdict: "SATISFIES", confidence: 0.9 });
  });
});
