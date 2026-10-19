/** The landing-page trial guest: the AI-answer cap, the write block, and what TrialSvc refuses.
 * No live Postgres: AuthRepo is monkeypatched on its class, same idiom as
 * test/account-restore-on-login.spec.ts. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import jwt from "jsonwebtoken";
import AuthRepo from "../src/repositories/auth.repository";
import TrialSvc from "../src/services/trial.service";
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
