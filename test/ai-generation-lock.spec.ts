import { expect } from "chai";
import { describe, it } from "mocha";
import { isJobStale } from "../src/utils/ai-generation-lock.utils";
import { HEARTBEAT_STALE_AFTER_MS, STALE_AFTER_MS } from "../src/constants";

describe("isJobStale", () => {
  const startedAt = new Date("2026-01-01T00:00:00.000Z");
  const at = (ms: number) => new Date(startedAt.getTime() + ms);

  describe("a job still waiting in the queue (no heartbeat yet)", () => {
    it("is not stale immediately after starting", () => {
      expect(isJobStale({ startedAt }, startedAt)).to.equal(false);
    });

    it("is not stale just under the threshold", () => {
      expect(isJobStale({ startedAt, heartbeatAt: null }, at(STALE_AFTER_MS - 1000))).to.equal(false);
    });

    it("is stale just past the threshold", () => {
      expect(isJobStale({ startedAt, heartbeatAt: null }, at(STALE_AFTER_MS + 1000))).to.equal(true);
    });
  });

  describe("a running job (heartbeat stamped)", () => {
    it("is not stale however long it has run, while its heartbeat is fresh", () => {
      const now = at(45 * 60 * 1000);
      expect(isJobStale({ startedAt, heartbeatAt: new Date(now.getTime() - 20_000) }, now)).to.equal(false);
    });

    it("is stale once its heartbeat has been silent past the threshold — the process running it is gone", () => {
      const heartbeatAt = at(60_000);
      expect(isJobStale({ startedAt, heartbeatAt }, new Date(heartbeatAt.getTime() + HEARTBEAT_STALE_AFTER_MS + 1000))).to.equal(true);
    });
  });
});
