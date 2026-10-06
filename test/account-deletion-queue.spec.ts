/** AccountDeletionQueue runs as a daily cron job like ConsultationDeletionQueue: it purges only
 * what has waited out the 30-day grace period, never purges a user who signed in meanwhile, and
 * one failed purge doesn't stop the rest. AuthRepo,
 * AccountDeletionSvc, the mailer and node-cron's schedule are monkeypatched, same idiom as
 * consultation-deletion-queue.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import cron from "node-cron";
import AccountDeletionQueue from "../src/queues/account-deletion.queue";
import AccountDeletionSvc from "../src/services/account-deletion.service";
import AuthRepo from "../src/repositories/auth.repository";
import * as mailerModule from "../src/utils/mailer";
import * as templateModule from "../src/utils/template";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-04T02:00:00Z");

type StubUser = { id: string; email: string; name: string | null; deletionRequestedAt: Date | null };

function stash<T extends object>(target: T, keys: string[]) {
  const saved = keys.map((k) => [k, (target as any)[k]] as const);
  return () => saved.forEach(([k, v]) => ((target as any)[k] = v));
}

describe("AccountDeletionQueue", () => {
  let restore: (() => void)[];
  let users: StubUser[];
  let purgePages: { afterId?: string; take?: number }[];
  let purgeCutoffs: Date[];
  let emails: { to: string; html: string }[];
  /** Runs inside purgeIfStillDue before its re-check — lets a test sign a user in mid-run. */
  let beforePurge: (id: string) => void;

  function daysAgo(days: number) {
    return new Date(NOW.getTime() - days * DAY);
  }

  function addUser(id: string, requestedDaysAgo: number) {
    users.push({ id, email: `${id}@firm.com`, name: id, deletionRequestedAt: daysAgo(requestedDaysAgo) });
  }

  beforeEach(() => {
    users = [];
    purgePages = [];
    purgeCutoffs = [];
    emails = [];
    beforePurge = () => {};

    restore = [
      stash(AuthRepo, ["findDueForHardDeletion"]),
      stash(AccountDeletionSvc, ["purgeIfStillDue"]),
      stash(mailerModule, ["sendEmail"]),
      stash(templateModule, ["renderTemplate"]),
    ];

    const page = <T extends { id: string }>(rows: T[], opts: { afterId?: string; take?: number }) =>
      rows
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .filter((u) => !opts.afterId || u.id > opts.afterId)
        .slice(0, opts.take ?? Infinity);

    (AuthRepo as any).findDueForHardDeletion = async (cutoff: Date, opts: { afterId?: string; take?: number } = {}) => {
      purgeCutoffs.push(cutoff);
      purgePages.push(opts);
      return page(users.filter((u) => u.deletionRequestedAt && u.deletionRequestedAt <= cutoff), opts);
    };
    (AccountDeletionSvc as any).purgeIfStillDue = async (id: string, cutoff: Date) => {
      if (id.endsWith("broken")) throw new Error("db hiccup");
      beforePurge(id);
      const u = users.find((x) => x.id === id);
      if (!u?.deletionRequestedAt || u.deletionRequestedAt > cutoff) return false;
      users = users.filter((x) => x.id !== id);
      return true;
    };
    (templateModule as any).renderTemplate = async (name: string) => name;
    (mailerModule as any).sendEmail = async (mail: { to: string; html: string }) => void emails.push(mail);
  });

  afterEach(() => restore.forEach((r) => r()));

  it("asks only for deletions requested 30 or more days ago", async () => {
    await AccountDeletionQueue.tick(NOW);
    expect(purgeCutoffs).to.have.length(1);
    expect(NOW.getTime() - purgeCutoffs[0]!.getTime()).to.equal(30 * DAY);
  });

  it("purges at 30 days, keeps 29 days, and emails only the purged user", async () => {
    addUser("due", 30);
    addUser("not-yet", 29);
    await AccountDeletionQueue.tick(NOW);
    expect(users.map((u) => u.id)).to.deep.equal(["not-yet"]);
    expect(emails).to.deep.equal([{ to: "due@firm.com", html: "account-deleted", subject: "Your ilovelawyer account has been deleted" } as any]);
  });

  it("carries on past a purge that fails", async () => {
    addUser("a", 31);
    addUser("b-broken", 31);
    addUser("c", 31);
    await AccountDeletionQueue.tick(NOW);
    expect(users.map((u) => u.id)).to.deep.equal(["b-broken"]);
  });

  it("pages through a large backlog 100 at a time", async () => {
    for (let i = 0; i < 250; i++) addUser(`u${String(i).padStart(3, "0")}`, 40);
    await AccountDeletionQueue.tick(NOW);
    expect(purgePages.map((p) => p.take)).to.deep.equal([100, 100, 100]);
    expect(users).to.have.length(0);
  });

  it("never purges or emails a user who signed in during the run", async () => {
    addUser("restored", 31);
    beforePurge = (id) => {
      const u = users.find((x) => x.id === id);
      if (u) u.deletionRequestedAt = null;
    };
    await AccountDeletionQueue.tick(NOW);
    expect(users.map((u) => u.id)).to.deep.equal(["restored"]);
    expect(emails).to.have.length(0);
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
      (AccountDeletionQueue as any).task = null;
      delete process.env.ACCOUNT_DELETION_CRON;
    });

    afterEach(() => {
      (cron as any).schedule = originalSchedule;
      (AccountDeletionQueue as any).task = null;
      delete process.env.ACCOUNT_DELETION_CRON;
    });

    it("runs daily at 02:00 UTC, without overlapping runs, and is scheduled only once", () => {
      AccountDeletionQueue.start();
      AccountDeletionQueue.start();
      expect(scheduled).to.have.length(1);
      expect(scheduled[0]!.expression).to.equal("0 2 * * *");
      expect(scheduled[0]!.options).to.include({ name: "account-deletion", timezone: "UTC", noOverlap: true });
    });

    it("takes a valid ACCOUNT_DELETION_CRON and ignores an invalid one", () => {
      process.env.ACCOUNT_DELETION_CRON = "30 3 * * *";
      AccountDeletionQueue.start();
      expect(scheduled[0]!.expression).to.equal("30 3 * * *");

      (AccountDeletionQueue as any).task = null;
      process.env.ACCOUNT_DELETION_CRON = "not a cron";
      AccountDeletionQueue.start();
      expect(scheduled[1]!.expression).to.equal("0 2 * * *");
    });
  });
});
