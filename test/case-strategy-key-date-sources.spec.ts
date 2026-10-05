import { expect } from "chai";
import { describe, it } from "mocha";
import { attachKeyDateDocuments, extractCaseStrategy } from "../src/utils/case-strategy-parse";

const A = "5dce9e77-e29c-46d6-94df-51a37c3c8c48";
const B = "9a1b2c3d-1111-2222-3333-444455556666";
const ready = [
  { id: A, name: "Termination Letter.pdf" },
  { id: B, name: "Payroll records.xlsx" },
];

describe("key date sources", () => {
  it("ties each key date to the document its handle names", () => {
    const reply = `[STRATEGY][][/STRATEGY][TODOS][][/TODOS][DATES]${JSON.stringify([
      { title: "Dismissal letter served", date: "2025-08-04", documentId: "D1", pageNumber: 2 },
      { title: "Last salary paid", date: "2025-08-08", documentId: "D2", pageNumber: null },
      { title: "Hearing", date: "2026-01-15", documentId: "D9", pageNumber: null },
      { title: "Meeting", date: "2025-08-06", documentId: null, pageNumber: null },
    ])}[/DATES]`;
    const dates = attachKeyDateDocuments(extractCaseStrategy(reply)!.dates!, ready);
    expect(dates.map((d) => [d.title, d.documentId])).to.deep.equal([
      ["Dismissal letter served", A],
      ["Last salary paid", B],
      ["Hearing", null],
      ["Meeting", null],
    ]);
    expect(dates[0]!.pageNumber).to.equal(2);
  });

  it("still accepts a full id, a garbled id with the right prefix, or the document's name", () => {
    const dates = attachKeyDateDocuments(
      [
        { title: "a", date: "2025-01-01", documentId: A, pageNumber: null },
        { title: "b", date: "2025-01-02", documentId: "5dce9e77-xxxx", pageNumber: null },
        { title: "c", date: "2025-01-03", documentId: "Payroll records", pageNumber: null },
      ],
      ready,
    );
    expect(dates.map((d) => d.documentId)).to.deep.equal([A, A, B]);
  });
});
