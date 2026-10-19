import { expect } from "chai";
import { describe, it } from "mocha";
import { FEEDBACK_COMMENT_MAX_CHARS } from "../src/constants/feedback.constants";
import { submitFeedbackSchema } from "../src/validation/feedback.validation";

describe("feedback comment length cap", () => {
  it("is 1,000 characters", () => {
    expect(FEEDBACK_COMMENT_MAX_CHARS).to.equal(1000);
  });
  it("accepts a comment of exactly the cap", () => {
    expect(submitFeedbackSchema.validate({ source: "GENERAL", comment: "a".repeat(FEEDBACK_COMMENT_MAX_CHARS) }).error).to.be.undefined;
  });
  it("rejects a comment over the cap on every source", () => {
    const comment = "a".repeat(FEEDBACK_COMMENT_MAX_CHARS + 1);
    for (const body of [
      { source: "GENERAL", comment },
      { source: "CHAT_ANSWER", rating: "UP", messageId: "m1", comment },
      { source: "CHAT_ANSWER", rating: "DOWN", messageId: "m1", comment },
      { source: "TERMINAL_PANE", caseId: "c1", panelId: "facts", comment },
    ]) {
      const { error } = submitFeedbackSchema.validate(body);
      expect(error?.message, body.source).to.include("1000");
    }
  });
});
