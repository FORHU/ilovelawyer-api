/** ConsultationDeletionQueue purges only what has waited out the grace period, and one failed
 * purge doesn't stop the rest. ChatRepo is monkeypatched, same idiom as consultation-access.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import ConsultationDeletionQueue from "../src/queues/consultation-deletion.queue";
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
});
