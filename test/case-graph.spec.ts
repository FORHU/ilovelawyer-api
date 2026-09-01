import { expect } from "chai";
import { describe, it } from "mocha";
import { computeStaleClosure } from "../src/utils/case-graph";

describe("computeStaleClosure", () => {
  it("marks a single direct target stale", () => {
    const edges = [{ sourceNodeId: "A", targetNodeId: "B" }];
    expect(computeStaleClosure(edges, ["A"])).to.have.members(["B"]);
  });

  it("walks a chain, marking every downstream node stale", () => {
    const edges = [
      { sourceNodeId: "A", targetNodeId: "B" },
      { sourceNodeId: "B", targetNodeId: "C" },
    ];
    expect(computeStaleClosure(edges, ["A"])).to.have.members(["B", "C"]);
  });

  it("returns nothing when the changed node has no outgoing edges", () => {
    const edges = [{ sourceNodeId: "A", targetNodeId: "B" }];
    expect(computeStaleClosure(edges, ["Z"])).to.deep.equal([]);
  });

  it("marks a shared target stale from either of two independent sources", () => {
    const edges = [
      { sourceNodeId: "A", targetNodeId: "C" },
      { sourceNodeId: "B", targetNodeId: "C" },
    ];
    expect(computeStaleClosure(edges, ["A"])).to.have.members(["C"]);
    expect(computeStaleClosure(edges, ["B"])).to.have.members(["C"]);
  });

  it("does not loop forever on a cycle", () => {
    const edges = [
      { sourceNodeId: "A", targetNodeId: "B" },
      { sourceNodeId: "B", targetNodeId: "A" },
    ];
    expect(computeStaleClosure(edges, ["A"])).to.have.members(["B", "A"]);
  });
});
