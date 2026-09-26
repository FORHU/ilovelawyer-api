import { expect } from "chai";
import { describe, it } from "mocha";
import { blockersMessage, findEventBlockers } from "../src/utils/reconstruction-prerequisites";

const doc = (name: string, ragStatus: "PENDING" | "READY" | "FAILED") => ({ name, ragStatus });

describe("findEventBlockers", () => {
  it("has nothing to say when there is a processed document — and never asks for a narrative", () => {
    expect(findEventBlockers({ documents: [doc("a.pdf", "READY")] })).to.deep.equal([]);
  });

  it("does not block on other documents still processing or failed once one is ready", () => {
    const docs = [doc("a.pdf", "READY"), doc("b.pdf", "PENDING"), doc("c.pdf", "FAILED")];
    expect(findEventBlockers({ documents: docs })).to.deep.equal([]);
  });

  it("tells the lawyer to upload documents when the case has none", () => {
    const blockers = findEventBlockers({ documents: [] });
    expect(blockers.map((b) => b.code)).to.deep.equal(["NO_DOCUMENTS"]);
    expect(blockers[0].action).to.contain("Upload");
  });

  it("names the documents still processing, and says to wait", () => {
    const [b] = findEventBlockers({ documents: [doc("letter.pdf", "PENDING"), doc("email.pdf", "PENDING")] });
    expect(b.code).to.equal("DOCUMENTS_PROCESSING");
    expect(b.problem).to.equal("2 documents are still being processed: letter.pdf, email.pdf.");
    expect(b.documents).to.deep.equal(["letter.pdf", "email.pdf"]);
    expect(b.action).to.contain("Wait");
  });

  it("names the documents that failed, and says what to do about them", () => {
    const [b] = findEventBlockers({ documents: [doc("scan.pdf", "FAILED")] });
    expect(b.code).to.equal("DOCUMENTS_FAILED");
    expect(b.problem).to.equal("1 document could not be processed: scan.pdf.");
    expect(b.action).to.contain("Re-upload it");
  });

  it("reports processing and failed documents together", () => {
    const codes = findEventBlockers({ documents: [doc("a", "PENDING"), doc("b", "FAILED")] }).map((b) => b.code);
    expect(codes).to.deep.equal(["DOCUMENTS_PROCESSING", "DOCUMENTS_FAILED"]);
  });

  it("caps a long list of names", () => {
    const docs = Array.from({ length: 8 }, (_, i) => doc(`d${i}.pdf`, "PENDING"));
    expect(findEventBlockers({ documents: docs })[0].problem).to.contain("d0.pdf, d1.pdf, d2.pdf, d3.pdf, d4.pdf and 3 more");
  });
});

describe("blockersMessage", () => {
  it("reads as one sentence for a single blocker and a numbered list for several", () => {
    const one = blockersMessage(findEventBlockers({ documents: [] }));
    expect(one).to.equal("The event chain can't be built yet. This case has no documents yet, and the event chain is built from the documents. Upload the case documents (pleadings, letters, emails, records) on the Evidence tab.");
    const many = blockersMessage(findEventBlockers({ documents: [doc("a.pdf", "PENDING"), doc("b.pdf", "FAILED")] }));
    expect(many).to.contain("1. 1 document is still being processed: a.pdf.").and.to.contain(" 2. 1 document could not be processed: b.pdf.");
  });
});
