import { expect } from "chai";
import { describe, it } from "mocha";
import { documentBelongsToScope } from "../src/utils/case-document-scope";

describe("documentBelongsToScope", () => {
  const userId = "user-1";
  const consultationId = "consult-1";
  const caseId = "case-1";

  it("allows a document attached to this consultation", () => {
    expect(
      documentBelongsToScope(
        { userId, caseId: null, consultationId },
        { userId, consultationId, caseId },
      ),
    ).to.equal(true);
  });

  it("allows a document attached to this case", () => {
    expect(
      documentBelongsToScope(
        { userId, caseId, consultationId: null },
        { userId, consultationId, caseId },
      ),
    ).to.equal(true);
  });

  it("rejects another user's document even if the case id matches", () => {
    expect(
      documentBelongsToScope(
        { userId: "other", caseId, consultationId: null },
        { userId, consultationId, caseId },
      ),
    ).to.equal(false);
  });

  it("rejects a document from a different case and consultation", () => {
    expect(
      documentBelongsToScope(
        { userId, caseId: "case-2", consultationId: "consult-2" },
        { userId, consultationId, caseId },
      ),
    ).to.equal(false);
  });
});
