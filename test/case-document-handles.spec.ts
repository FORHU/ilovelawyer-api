import { expect } from "chai";
import { describe, it } from "mocha";
import { normalizeMindMap, MindMapItem } from "../src/utils/response-parser";
import { docsForPrompt, excerptBlock, excerptsWithHandles, resolveCaseSources, resolveDocumentRef, resolveRawSources } from "../src/utils/case-document-handles";

const A = "5dce9e77-e29c-46d6-94df-51a37c3c8c48";
const B = "9a1b2c3d-1111-2222-3333-444455556666";
const docs = [
  { id: A, name: "Termination Letter.pdf" },
  { id: B, name: "Payroll records.xlsx" },
];

describe("mind map citations", () => {
  it("lists documents by handle, and heads excerpts with the same handle", () => {
    expect(docsForPrompt(docs)).to.deep.equal([
      { id: "D1", name: "Termination Letter.pdf" },
      { id: "D2", name: "Payroll records.xlsx" },
    ]);
    expect(excerptsWithHandles(`[${A} p.2]\ntext\n\n[${B}]\nmore`, docs)).to.equal("[D1 p.2]\ntext\n\n[D2]\nmore");
  });

  it("resolves a handle, an exact id, a garbled id with the right prefix, or the document's name", () => {
    expect(resolveDocumentRef("D2", docs)).to.equal(B);
    expect(resolveDocumentRef("[d1]", docs)).to.equal(A);
    expect(resolveDocumentRef(A, docs)).to.equal(A);
    expect(resolveDocumentRef("5dce9e77-e29c-46d6-94df-51a37c3c8c4X", docs)).to.equal(A);
    expect(resolveDocumentRef("termination letter", docs)).to.equal(A);
    expect(resolveDocumentRef("Payroll records.xlsx", docs)).to.equal(B);
  });

  it("matches nothing for an unknown handle, an ambiguous prefix or an invented id", () => {
    expect(resolveDocumentRef("D9", docs)).to.equal(null);
    expect(resolveDocumentRef("F1", docs)).to.equal(null);
    expect(resolveDocumentRef("deadbeef-0000", docs)).to.equal(null);
    expect(resolveDocumentRef("", docs)).to.equal(null);
  });

  it("rewrites a whole map's citations to real ids, dropping what matches nothing", () => {
    const tree = normalizeMindMap({
      id: "root",
      label: "Case",
      children: [
        {
          id: "keyFacts",
          label: "Key Facts",
          children: [
            { label: "Dismissed 4 Aug", sources: [{ documentId: "D1", page: 2 }, { documentId: "invented" }, "D1"], children: [] },
            { label: "Paid to 8 Aug", sources: ["D2"], children: [] },
          ],
        },
      ],
    }) as MindMapItem;
    const { dropped, unmatched } = resolveCaseSources(tree, docs);
    expect(dropped).to.equal(1);
    expect(unmatched).to.deep.equal(["invented"]);
    expect(tree.children[0]!.children[0]!.sources).to.deep.equal([{ documentId: A, page: 2 }, { documentId: A }]);
    expect(tree.children[0]!.children[1]!.sources).to.deep.equal([{ documentId: B }]);
  });

  it("resolves an expanded point's raw citations", () => {
    expect(resolveRawSources([{ documentId: "D2", page: 4 }, "nope", { id: "D1" }], docs)).to.deep.equal([
      { documentId: B, page: 4 },
      { documentId: A },
    ]);
  });

  it("heads an expand's passages with each document's handle, leaving out other documents", () => {
    const block = excerptBlock(
      [
        { caseDocumentId: B, chunkText: "Paid to 8 Aug", pageNumber: 3 },
        { caseDocumentId: "someone-else", chunkText: "not this case", pageNumber: 1 },
        { caseDocumentId: A, chunkText: "x".repeat(900), pageNumber: null },
      ],
      docs,
    );
    const head = "[D2 p.3]\nPaid to 8 Aug\n\n[D1]\n";
    expect(block.startsWith(head)).to.equal(true);
    expect(block).to.not.contain("not this case");
    expect(block.length).to.equal(head.length + 700);
  });
});
