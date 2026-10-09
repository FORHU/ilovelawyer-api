import { describe, expect, it } from "vitest";
import { CASE_NOTES_MAX_LENGTH, updateCaseSchema } from "../src/validation/case.validation";

describe("case notes length cap", () => {
  it("accepts notes at the cap and empty notes (clearing)", () => {
    expect(updateCaseSchema.validate({ notes: "a".repeat(CASE_NOTES_MAX_LENGTH) }).error).toBeUndefined();
    expect(updateCaseSchema.validate({ notes: "" }).error).toBeUndefined();
  });
  it("rejects notes over the cap", () => {
    const { error } = updateCaseSchema.validate({ notes: "a".repeat(CASE_NOTES_MAX_LENGTH + 1) });
    expect(error?.message).toContain("5000");
  });
});
