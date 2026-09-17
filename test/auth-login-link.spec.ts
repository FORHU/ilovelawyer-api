/** AuthSvc.consumeLoginLink — the counterpart to resetPassword: consumes the one-time "Login"
 * link token minted by AdminSvc.transition (see admin-session-revocation.spec.ts) and mints a
 * brand-new session.
 *
 * No live Postgres: AuthRepo is monkeypatched on its CommonJS module object, same idiom as
 * test/decision-record-service.spec.ts.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import AuthSvc from "../src/services/auth.service";
import AuthRepo from "../src/repositories/auth.repository";

describe("AuthSvc.consumeLoginLink", () => {
  const originals = {
    consumeLoginLinkToken: AuthRepo.consumeLoginLinkToken,
    deleteSessionsByUserId: AuthRepo.deleteSessionsByUserId,
    createSession: AuthRepo.createSession,
    updateLastLogin: AuthRepo.updateLastLogin,
    findById: AuthRepo.findById,
  };

  let revokedUserIds: string[];
  let createdSessions: { userId: string; refreshToken: string }[];
  let lastLoginUpdated: string[];

  beforeEach(() => {
    revokedUserIds = [];
    createdSessions = [];
    lastLoginUpdated = [];

    (AuthRepo as any).deleteSessionsByUserId = async (userId: string) => {
      revokedUserIds.push(userId);
    };
    (AuthRepo as any).createSession = async (userId: string, refreshToken: string) => {
      createdSessions.push({ userId, refreshToken });
    };
    (AuthRepo as any).updateLastLogin = async (userId: string) => {
      lastLoginUpdated.push(userId);
    };
    (AuthRepo as any).findById = async (id: string) => ({ id, email: "user@example.com", approvalStatus: "ACTIVE" });
  });

  afterEach(() => {
    (AuthRepo as any).consumeLoginLinkToken = originals.consumeLoginLinkToken;
    (AuthRepo as any).deleteSessionsByUserId = originals.deleteSessionsByUserId;
    (AuthRepo as any).createSession = originals.createSession;
    (AuthRepo as any).updateLastLogin = originals.updateLastLogin;
    (AuthRepo as any).findById = originals.findById;
  });

  it("mints a fresh session and returns the user on a valid token", async () => {
    (AuthRepo as any).consumeLoginLinkToken = async (token: string) => (token === "good-token" ? "user-1" : null);

    const result = await AuthSvc.consumeLoginLink("good-token");

    expect(result.user).to.include({ id: "user-1" });
    expect(result.accessToken).to.be.a("string").that.is.not.empty;
    expect(result.refreshToken).to.be.a("string").that.is.not.empty;
    expect(revokedUserIds).to.deep.equal(["user-1"]);
    expect(createdSessions).to.have.length(1);
    expect(createdSessions[0].userId).to.equal("user-1");
    expect(lastLoginUpdated).to.deep.equal(["user-1"]);
  });

  it("rejects an invalid, expired, or already-used token with a 400", async () => {
    (AuthRepo as any).consumeLoginLinkToken = async () => null;

    let threw: any;
    try {
      await AuthSvc.consumeLoginLink("bad-token");
    } catch (e) {
      threw = e;
    }

    expect(threw).to.exist;
    expect(threw.status ?? threw.statusCode).to.equal(400);
    expect(revokedUserIds).to.have.length(0);
    expect(createdSessions).to.have.length(0);
  });
});
