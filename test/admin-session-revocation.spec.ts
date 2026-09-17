/** AdminSvc.transition — the shared state-machine method behind approve/deny/reactivate/
 * block/unblock. Covers the bug fix where approving (or any other status transition) failed to
 * revoke the user's existing session, letting a stale pre-approval refresh-token cookie
 * silently re-authenticate them after a page refresh. Also covers the "Login" link minted
 * only for approve.
 *
 * No live Postgres/Redis: AuthRepo, mailer's sendEmail and template's renderTemplate are
 * monkeypatched on their CommonJS module objects, same idiom as
 * test/decision-record-service.spec.ts / test/case-post-extraction.spec.ts.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import AdminSvc from "../src/services/admin.service";
import AuthRepo from "../src/repositories/auth.repository";
import * as mailerModule from "../src/utils/mailer";
import * as templateModule from "../src/utils/template";

function user(over: Partial<{ id: string; approvalStatus: string; email: string; name: string | null }> = {}) {
  return { id: "user-1", approvalStatus: "PENDING", email: "user@example.com", name: "Jane", ...over };
}

describe("AdminSvc.transition — session revocation and login-link generation", () => {
  const originals = {
    findById: AuthRepo.findById,
    setApprovalStatus: AuthRepo.setApprovalStatus,
    deleteSessionsByUserId: AuthRepo.deleteSessionsByUserId,
    setLoginLinkToken: AuthRepo.setLoginLinkToken,
    sendEmail: (mailerModule as any).sendEmail,
    renderTemplate: (templateModule as any).renderTemplate,
  };

  let revokedUserIds: string[];
  let loginLinkTokenCalls: { userId: string; token: string }[];
  let renderedVars: { name: string; template: string; vars: Record<string, string> }[];
  let currentUser: ReturnType<typeof user>;

  beforeEach(() => {
    revokedUserIds = [];
    loginLinkTokenCalls = [];
    renderedVars = [];
    currentUser = user();

    (AuthRepo as any).findById = async (id: string) => (id === currentUser.id ? currentUser : null);
    (AuthRepo as any).setApprovalStatus = async (id: string, status: string) => {
      currentUser = { ...currentUser, approvalStatus: status };
      return currentUser;
    };
    (AuthRepo as any).deleteSessionsByUserId = async (userId: string) => {
      revokedUserIds.push(userId);
    };
    (AuthRepo as any).setLoginLinkToken = async (userId: string, token: string) => {
      loginLinkTokenCalls.push({ userId, token });
    };
    (mailerModule as any).sendEmail = async () => {};
    (templateModule as any).renderTemplate = async (name: string, vars: Record<string, string>) => {
      renderedVars.push({ name, template: name, vars });
      return "<html></html>";
    };
  });

  afterEach(() => {
    (AuthRepo as any).findById = originals.findById;
    (AuthRepo as any).setApprovalStatus = originals.setApprovalStatus;
    (AuthRepo as any).deleteSessionsByUserId = originals.deleteSessionsByUserId;
    (AuthRepo as any).setLoginLinkToken = originals.setLoginLinkToken;
    (mailerModule as any).sendEmail = originals.sendEmail;
    (templateModule as any).renderTemplate = originals.renderTemplate;
  });

  it("approve revokes the user's existing session and mints a login-link token", async () => {
    await AdminSvc.approve("user-1");
    expect(revokedUserIds).to.deep.equal(["user-1"]);
    expect(loginLinkTokenCalls).to.have.length(1);
    expect(loginLinkTokenCalls[0].userId).to.equal("user-1");
    expect(renderedVars[0].vars.loginLink).to.include("/login-link?token=");
    expect(renderedVars[0].vars.loginLink).to.include(loginLinkTokenCalls[0].token);
  });

  it("deny revokes the session too, but mints no login-link token", async () => {
    await AdminSvc.deny("user-1", "insufficient info");
    expect(revokedUserIds).to.deep.equal(["user-1"]);
    expect(loginLinkTokenCalls).to.have.length(0);
    expect(renderedVars[0].vars.loginLink).to.equal("");
  });

  it("block revokes the session for an already-ACTIVE user", async () => {
    currentUser = user({ approvalStatus: "ACTIVE" });
    await AdminSvc.block("user-1");
    expect(revokedUserIds).to.deep.equal(["user-1"]);
    expect(loginLinkTokenCalls).to.have.length(0);
  });

  it("unblock revokes the session and mints no login-link token", async () => {
    currentUser = user({ approvalStatus: "BLOCKED" });
    await AdminSvc.unblock("user-1");
    expect(revokedUserIds).to.deep.equal(["user-1"]);
    expect(loginLinkTokenCalls).to.have.length(0);
  });

  it("reactivate revokes the session for a DENIED user", async () => {
    currentUser = user({ approvalStatus: "DENIED" });
    await AdminSvc.reactivate("user-1");
    expect(revokedUserIds).to.deep.equal(["user-1"]);
    expect(loginLinkTokenCalls).to.have.length(0);
  });

  it("rejects a transition from the wrong state without touching sessions", async () => {
    currentUser = user({ approvalStatus: "ACTIVE" });
    let threw: any;
    try {
      await AdminSvc.approve("user-1");
    } catch (e) {
      threw = e;
    }
    expect(threw).to.exist;
    expect(threw.status ?? threw.statusCode).to.equal(409);
    expect(revokedUserIds).to.have.length(0);
  });
});
