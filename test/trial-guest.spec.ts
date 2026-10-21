/** The landing-page trial guest: the AI-answer cap, the write block, and what TrialSvc refuses.
 * No live Postgres: AuthRepo is monkeypatched on its class, same idiom as
 * test/account-restore-on-login.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import jwt from "jsonwebtoken";
import AuthRepo from "../src/repositories/auth.repository";
import TrialSvc from "../src/services/trial.service";
import TerminalWorkspaceRepo from "../src/repositories/terminal-workspace.repository";
import TerminalWorkspaceSvc from "../src/services/terminal-workspace.service";
import ChatSvc from "../src/services/chat.service";
import ChatRepo from "../src/repositories/chat.repository";
import { redis } from "../src/lib/redis";
import { trialSampleKey } from "../src/utils/chat.utils";
import { blockTrialWrites, trialMessageLimit } from "../src/middleware/trial.middleware";
import { ACCESS_TOKEN_SECRET } from "../src/config";

function run(mw: (req: any, res: any, next: (err?: any) => void) => Promise<void>, req: any): Promise<any> {
  return new Promise((resolve) => {
    void mw(req, {}, (err?: any) => resolve(err ?? null));
  });
}

describe("Trial guest", () => {
  let saved: Record<string, any>;
  let trial: { expiresAt: Date; messagesUsed: number } | null;
  let left: number;

  beforeEach(() => {
    saved = { findTrialState: AuthRepo.findTrialState, spendTrialMessage: AuthRepo.spendTrialMessage };
    trial = { expiresAt: new Date(Date.now() + 60_000), messagesUsed: 0 };
    left = 1;
    (AuthRepo as any).findTrialState = async () => trial;
    (AuthRepo as any).spendTrialMessage = async () => left-- > 0;
  });
  afterEach(() => Object.assign(AuthRepo, saved));

  it("lets a guest send until the cap, then answers 403 TRIAL_LIMIT_REACHED", async () => {
    const req = { user: { userId: "u1" } };
    expect(await run(trialMessageLimit, req)).to.equal(null);
    const err = await run(trialMessageLimit, req);
    expect(err.statusCode).to.equal(403);
    expect(err.code).to.equal("TRIAL_LIMIT_REACHED");
  });

  it("does not count or limit a real account", async () => {
    trial = null;
    expect(await run(trialMessageLimit, { user: { userId: "u1" } })).to.equal(null);
    expect(left).to.equal(1);
  });

  it("blocks a guest's writes but not their reads or anyone else's writes", async () => {
    const token = jwt.sign({ userId: "u1" }, ACCESS_TOKEN_SECRET);
    const headers = { authorization: `Bearer ${token}` };
    const blocked = await run(blockTrialWrites, { method: "POST", headers });
    expect(blocked.code).to.equal("TRIAL_RESTRICTED");
    expect(await run(blockTrialWrites, { method: "GET", headers })).to.equal(null);
    expect(await run(blockTrialWrites, { method: "POST", headers: {} })).to.equal(null);
    trial = null;
    expect(await run(blockTrialWrites, { method: "POST", headers })).to.equal(null);
  });

  it("only starts a trial on the UK tenant", async () => {
    for (const code of [null, "PH"] as const) {
      try {
        await TrialSvc.start(code);
        expect.fail("should have refused");
      } catch (err: any) {
        expect(err.statusCode).to.equal(404);
      }
    }
  });
});

describe("Sample chat session recap", () => {
  // The model's memory is a Chat Wonder session, so a guest's first send in a new one has to carry
  // the sample answer or a follow-up is answered as if the chat were new. Only the seeded sample.
  const ChatSvcAny = ChatSvc as any;
  let saved: Record<string, any>;
  let isSample: boolean;
  let primed: string | null;
  let messages: any[];

  beforeEach(() => {
    saved = { list: ChatRepo.listMessagesByConsultation, get: redis.get };
    isSample = true;
    primed = null;
    messages = [
      { id: "q1", role: "user", content: "What are her remedies?", replyStatus: "DONE" },
      { id: "a1", role: "assistant", content: "Damages under s.2(1), or rescission.", replyStatus: null },
      { id: "q2", role: "user", content: "And if there is an entire agreement clause?", replyStatus: "PENDING" },
    ];
    (ChatRepo as any).listMessagesByConsultation = async () => messages;
    (redis as any).get = async (key: string) => (key === trialSampleKey("c1") ? (isSample ? "1" : null) : primed);
  });
  afterEach(() => {
    (ChatRepo as any).listMessagesByConsultation = saved.list;
    (redis as any).get = saved.get;
  });

  const recap = () => ChatSvcAny.trialSessionRecap("c1", "s1", "q2") as Promise<string | undefined>;

  it("carries the sample question and answer, not the message being sent", async () => {
    const text = await recap();
    expect(text).to.include("Question: What are her remedies?");
    expect(text).to.include("Answer: Damages under s.2(1), or rescission.");
    expect(text).to.not.include("entire agreement");
  });

  it("is sent once per session", async () => {
    primed = "1";
    expect(await recap()).to.equal(undefined);
  });

  it("is only for the sample chat: any other consultation is left alone", async () => {
    isSample = false;
    expect(await recap()).to.equal(undefined);
  });
});

describe("Sample-case guest layout", () => {
  const CASE = "case-1";
  let saved: Record<string, any>;
  let layouts: { id: string; caseId: string; name: string; userId: string }[];
  let selected: Record<string, string>;
  let deleted: string[];
  let owner: string | null;
  let racer: { id: string; caseId: string; name: string; userId: string } | null;

  beforeEach(() => {
    saved = {
      findOldestNamed: TerminalWorkspaceRepo.findOldestNamed,
      caseOwnerId: TerminalWorkspaceRepo.caseOwnerId,
      create: TerminalWorkspaceRepo.create,
      markLastUsed: TerminalWorkspaceRepo.markLastUsed,
      delete: TerminalWorkspaceRepo.delete,
      skuForUser: TerminalWorkspaceSvc.skuForUser,
    };
    layouts = [];
    selected = {};
    deleted = [];
    owner = "case-owner";
    racer = null;
    (TerminalWorkspaceRepo as any).findOldestNamed = async (caseId: string, name: string) => layouts.find((l) => l.caseId === caseId && l.name === name) ?? null;
    (TerminalWorkspaceRepo as any).caseOwnerId = async () => owner;
    (TerminalWorkspaceRepo as any).create = async (userId: string, data: { caseId: string; name: string }) => {
      const row = { id: `ws-${layouts.length + 1}`, userId, caseId: data.caseId, name: data.name };
      // Another guest started at the same moment and created theirs first.
      if (racer) layouts.push(racer);
      layouts.push(row);
      return row;
    };
    (TerminalWorkspaceRepo as any).markLastUsed = async (id: string, userId: string) => {
      selected[userId] = id;
      return { id };
    };
    (TerminalWorkspaceRepo as any).delete = async (id: string) => {
      deleted.push(id);
      layouts = layouts.filter((l) => l.id !== id);
    };
    (TerminalWorkspaceSvc as any).skuForUser = async () => "SOLO";
  });
  afterEach(() => {
    Object.assign(TerminalWorkspaceRepo, saved);
    (TerminalWorkspaceSvc as any).skuForUser = saved.skuForUser;
  });

  const seed = (guest: string) => (TrialSvc as any).seedGuestLayout(guest, CASE) as Promise<void>;

  it("makes one layout, owned by the case's owner, and opens it for the first guest", async () => {
    await seed("guest-a");
    expect(layouts).to.have.length(1);
    expect(layouts[0]!.userId).to.equal("case-owner");
    expect(layouts[0]!.name).to.equal("Case overview");
    expect(selected["guest-a"]).to.equal(layouts[0]!.id);
  });

  it("gives every later guest the same layout instead of another tab", async () => {
    await seed("guest-a");
    await seed("guest-b");
    await seed("guest-c");
    expect(layouts).to.have.length(1);
    expect(selected["guest-b"]).to.equal(layouts[0]!.id);
    expect(selected["guest-c"]).to.equal(layouts[0]!.id);
  });

  it("keeps the oldest when two guests start at the same moment", async () => {
    racer = { id: "ws-first", userId: "case-owner", caseId: CASE, name: "Case overview" };
    await seed("guest-b");
    expect(layouts.map((l) => l.id)).to.deep.equal(["ws-first"]);
    expect(deleted).to.have.length(1);
    expect(selected["guest-b"]).to.equal("ws-first");
  });

  it("falls back to the guest as owner when the case has none", async () => {
    owner = null;
    await seed("guest-a");
    expect(layouts[0]!.userId).to.equal("guest-a");
  });
});
