/** ConsultationDeletionQueue runs as a daily cron job, purges only what has waited out the grace
 * period, and one failed purge doesn't stop the rest. ChatRepo and node-cron's schedule are
 * monkeypatched, same idiom as consultation-access.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import ConsultationDeletionQueue from "../src/queues/consultation-deletion.queue";
import cron from "node-cron";
import ChatRepo from "../src/repositories/chat.repository";

const DAY = 24 * 60 * 60 * 1000;

describe("ConsultationDeletionQueue", () => {
  const originals = {
    findDue: ChatRepo.findConsultationsDueForDeletion,
    purge: ChatRepo.deleteConsultationPermanently,
  };
  let cutoffs: Date[];
  let purged: string[];

  beforeEach(() => {
    cutoffs = [];
    purged = [];
    (ChatRepo as any).findConsultationsDueForDeletion = async (cutoff: Date) => {
      cutoffs.push(cutoff);
      return [{ id: "a" }, { id: "broken" }, { id: "b" }];
    };
    (ChatRepo as any).deleteConsultationPermanently = async (id: string) => {
      if (id === "broken") throw new Error("gone already");
      purged.push(id);
      return { filesMarkedForDeletion: 0 };
    };
  });

  afterEach(() => {
    (ChatRepo as any).findConsultationsDueForDeletion = originals.findDue;
    (ChatRepo as any).deleteConsultationPermanently = originals.purge;
  });

  it("asks only for deletions requested 30 or more days ago", async () => {
    const now = new Date("2026-11-04T12:00:00Z");
    await ConsultationDeletionQueue.tick(now);
    expect(cutoffs).to.have.length(1);
    expect(now.getTime() - cutoffs[0]!.getTime()).to.equal(30 * DAY);
  });

  it("purges every due consultation, carrying on past one that fails", async () => {
    await ConsultationDeletionQueue.tick();
    expect(purged).to.deep.equal(["a", "b"]);
  });

  describe("scheduling", () => {
    const originalSchedule = cron.schedule;
    let scheduled: { expression: string; options: unknown }[];

    beforeEach(() => {
      scheduled = [];
      (cron as any).schedule = (expression: string, _fn: unknown, options: unknown) => {
        scheduled.push({ expression, options });
        return { stop: () => {} };
      };
      (ConsultationDeletionQueue as any).task = null;
      delete process.env.CONSULTATION_DELETION_CRON;
    });

    afterEach(() => {
      (cron as any).schedule = originalSchedule;
      (ConsultationDeletionQueue as any).task = null;
      delete process.env.CONSULTATION_DELETION_CRON;
    });

    it("runs daily at 02:00 UTC, without overlapping runs, and is scheduled only once", () => {
      ConsultationDeletionQueue.start();
      ConsultationDeletionQueue.start();
      expect(scheduled).to.have.length(1);
      expect(scheduled[0]!.expression).to.equal("0 2 * * *");
      expect(scheduled[0]!.options).to.include({ timezone: "UTC", noOverlap: true });
    });

    it("takes a valid CONSULTATION_DELETION_CRON and ignores an invalid one", () => {
      process.env.CONSULTATION_DELETION_CRON = "30 3 * * *";
      ConsultationDeletionQueue.start();
      expect(scheduled[0]!.expression).to.equal("30 3 * * *");

      (ConsultationDeletionQueue as any).task = null;
      process.env.CONSULTATION_DELETION_CRON = "not a cron";
      ConsultationDeletionQueue.start();
      expect(scheduled[1]!.expression).to.equal("0 2 * * *");
    });
  });
});
