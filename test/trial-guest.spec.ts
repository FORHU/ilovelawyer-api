/** The landing-page trial guest: the AI-answer cap, the write block, and what TrialSvc refuses.
 * No live Postgres: AuthRepo is monkeypatched on its class, same idiom as
 * test/account-restore-on-login.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import jwt from "jsonwebtoken";
import AuthRepo from "../src/repositories/auth.repository";
import TrialSvc from "../src/services/trial.service";
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
