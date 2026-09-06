import { expect } from "chai";
import { describe, it } from "mocha";
import { isJobStale } from "../src/utils/ai-generation-lock.utils";
import { STALE_AFTER_MS } from "../src/constants";

describe("isJobStale", () => {
  it("is not stale immediately after starting", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(isJobStale(now, now)).to.equal(false);
  });

  it("is not stale just under the threshold", () => {
    const startedAt = new Date("2026-01-01T00:00:00.000Z");
    const now = new Date(startedAt.getTime() + STALE_AFTER_MS - 1000);
    expect(isJobStale(startedAt, now)).to.equal(false);
  });

  it("is stale just past the threshold", () => {
    const startedAt = new Date("2026-01-01T00:00:00.000Z");
    const now = new Date(startedAt.getTime() + STALE_AFTER_MS + 1000);
    expect(isJobStale(startedAt, now)).to.equal(true);
  });
});
