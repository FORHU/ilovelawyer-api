import { expect } from "chai";
import { describe, it } from "mocha";
import {
  extractMindMap,
  parseStructuredDataPayload,
  normalizeMindMap,
  stripStructuredBlocks,
} from "../src/utils/response-parser";

const tree = {
  id: "root",
  label: "Illegal dismissal",
  isRoot: true,
  children: [
    { id: "facts", label: "Key Facts", children: [{ id: "f1", label: "No notice", children: [] }] },
    { id: "law", label: "Legal Basis", children: [] },
  ],
};

describe("response-parser — mind map", () => {
  it("parses Chat Wonder [STRUCTURED_DATA] timeline + mindMap", () => {
    const parsed = parseStructuredDataPayload(
      JSON.stringify({
        timeline: [{ title: "File complaint", description: "NLRC", status: "pending" }],
        mindMap: tree,
      }),
    );
    expect(parsed.mindMap?.label).to.equal("Illegal dismissal");
    expect(parsed.mindMap?.children).to.have.length(2);
    expect(parsed.timeline).to.have.length(1);
  });

  it("unwraps a nested root object", () => {
    const parsed = normalizeMindMap({ root: tree });
    expect(parsed?.id).to.equal("root");
    expect(parsed?.children?.[0]?.label).to.equal("Key Facts");
  });

  it("still extracts inline [MINDMAP] tags", () => {
    const text = `Here is the analysis.\n[MINDMAP]\n${JSON.stringify(tree)}\n[/MINDMAP]`;
    const map = extractMindMap(text);
    expect(map?.label).to.equal("Illegal dismissal");
    expect(stripStructuredBlocks(text)).to.not.include("Illegal dismissal");
  });

  it("strips a leaked [STRUCTURED_DATA] frame from chat text", () => {
    const text = `Answer.\n[STRUCTURED_DATA]${JSON.stringify({ mindMap: tree })}[DONE]`;
    expect(stripStructuredBlocks(text)).to.equal("Answer.");
  });
});
