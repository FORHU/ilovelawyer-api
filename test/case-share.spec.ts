import { expect } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { resolveOrganizationAllowingGuests } from "../src/middleware/resolve-organization.middleware";
import { guestItemNeedsCase, guestListNeedsCase, guestRefused } from "../src/middleware/guest-case-items.middleware";
import OrganizationSvc from "../src/services/organization.service";
import OrganizationRepo from "../src/repositories/organization.repository";
import CaseShareRepo from "../src/repositories/case-share.repository";
import CaseShareSvc from "../src/services/case-share.service";
import NotificationSvc from "../src/services/notification.service";
import HttpError from "../src/utils/http-error";
import * as socket from "../src/lib/socket";

// Sharing a portfolio case: individual registered users, read-only, never a copy of an
// organization's case. The recipient reaches it as a guest of the owner's portfolio.

const stash = {
  requireMembership: OrganizationSvc.requireMembership,
  findSharedPortfolio: OrganizationRepo.findSharedPortfolio,
  grantCaseAccess: OrganizationRepo.grantCaseAccess,
  writeAudit: OrganizationRepo.writeAudit,
  findOwnedPortfolioCase: CaseShareRepo.findOwnedPortfolioCase,
  findRecipient: CaseShareRepo.findRecipient,
  removeShare: CaseShareRepo.removeShare,
  notify: NotificationSvc.create,
  emitToUser: socket.emitToUser,
  removeUserFromCase: socket.removeUserFromCase,
};
const restore = () => {
  Object.assign(OrganizationSvc, { requireMembership: stash.requireMembership });
  Object.assign(OrganizationRepo, { findSharedPortfolio: stash.findSharedPortfolio, grantCaseAccess: stash.grantCaseAccess, writeAudit: stash.writeAudit });
  Object.assign(CaseShareRepo, { findOwnedPortfolioCase: stash.findOwnedPortfolioCase, findRecipient: stash.findRecipient, removeShare: stash.removeShare });
  Object.assign(NotificationSvc, { create: stash.notify });
  Object.assign(socket, { emitToUser: stash.emitToUser, removeUserFromCase: stash.removeUserFromCase });
};

async function statusOf(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return (error as HttpError).statusCode;
  }
  return 0;
}

describe("resolveOrganizationAllowingGuests", () => {
  const request = (method: string, baseUrl: string, path: string) =>
    ({ method, baseUrl, path, headers: { "x-organization-id": "alice-portfolio" }, user: { userId: "bob" } }) as any;
  const run = async (req: any) => {
    let called = false;
    await resolveOrganizationAllowingGuests(req, {} as any, () => (called = true));
    return called;
  };

  beforeEach(() => {
    (OrganizationSvc as any).requireMembership = async () => {
      throw new HttpError("Not a member of this organization", 403);
    };
    (OrganizationRepo as any).findSharedPortfolio = async () => ({ id: "alice-portfolio", tenant: { code: "UK" } });
  });
  afterEach(restore);

  it("lets a share holder read as a guest of the owner's portfolio", async () => {
    const req = request("GET", "/api/my-cases", "/c1");
    expect(await run(req)).to.equal(true);
    expect(req.organization).to.deep.equal({ id: "alice-portfolio", role: "MEMBER", tenantCode: "UK", guest: true });
  });

  it("refuses a guest's writes", async () => {
    for (const [method, base, path] of [
      ["POST", "/api/my-cases", "/c1/findings/regenerate"],
      ["PATCH", "/api/terminal", "/workspaces/w1"],
      ["DELETE", "/api/documents", "/d1"],
      ["POST", "/api/v1/documents", "/"],
    ]) {
      expect(await statusOf(() => run(request(method, base, path))), `${method} ${base}${path}`).to.equal(403);
    }
  });

  it("still lets a guest pick a layout tab and mark the case opened", async () => {
    expect(await run(request("POST", "/api/terminal", "/workspaces/w1/apply"))).to.equal(true);
    expect(await run(request("POST", "/api/my-cases", "/c1/opened"))).to.equal(true);
  });

  it("refuses someone with no share, with the membership error", async () => {
    (OrganizationRepo as any).findSharedPortfolio = async () => null;
    expect(await statusOf(() => run(request("GET", "/api/my-cases", "/")))).to.equal(403);
  });

  it("resolves a member as before, with no guest flag", async () => {
    (OrganizationSvc as any).requireMembership = async () => ({ role: "ADMIN", organization: { tenant: { code: "PH" } } });
    const req = request("POST", "/api/my-cases", "/");
    expect(await run(req)).to.equal(true);
    expect(req.organization.guest).to.equal(undefined);
  });
});

describe("guest case-item guards", () => {
  const guest = (query: object = {}) => ({ organization: { id: "alice-portfolio", guest: true }, query }) as any;

  it("makes a guest list one case's documents, not the whole workspace's", () => {
    let error: unknown = "none";
    guestListNeedsCase(guest(), {} as any, (e?: unknown) => (error = e));
    expect((error as HttpError).statusCode).to.equal(403);
    guestListNeedsCase(guest({ caseId: "c1" }), {} as any, (e?: unknown) => (error = e));
    expect(error).to.equal(undefined);
  });

  it("hides an item with no case from a guest", async () => {
    const outcome = (caseId: string | null) =>
      new Promise((resolve) => guestItemNeedsCase(async () => ({ caseId }))(guest(), {} as any, resolve, "d1"));
    expect(((await outcome(null)) as HttpError).statusCode).to.equal(404);
    expect(await outcome("c1")).to.equal(undefined);
  });

  it("makes a guest list one case's consultations, and hides a standalone one", async () => {
    let error: unknown = "none";
    guestListNeedsCase(guest(), {} as any, (e?: unknown) => (error = e));
    expect((error as HttpError).statusCode).to.equal(403);
    const standalone = await new Promise((resolve) => guestItemNeedsCase(async () => ({ caseId: null }))(guest(), {} as any, resolve, "consultation-1"));
    expect((standalone as HttpError).statusCode).to.equal(404);
  });

  it("refuses a guest the parts of a router a share never includes, like invite links", () => {
    let error: unknown = "none";
    guestRefused(guest(), {} as any, (e?: unknown) => (error = e));
    expect((error as HttpError).statusCode).to.equal(403);
    guestRefused({ organization: { id: "org" } } as any, {} as any, (e?: unknown) => (error = e));
    expect(error).to.equal(undefined);
  });

  it("leaves members alone", () => {
    let error: unknown = "none";
    guestListNeedsCase({ organization: { id: "org" }, query: {} } as any, {} as any, (e?: unknown) => (error = e));
    expect(error).to.equal(undefined);
  });
});

describe("CaseShareSvc", () => {
  const ownCase = (overrides: object = {}) => ({
    id: "c1",
    caseName: "Marchetti v Braybourne",
    copiedFromCaseId: null,
    organizationId: "alice-portfolio",
    organization: { tenantId: "uk", createdBy: { name: "Alice", username: "alice" } },
    ...overrides,
  });
  const bob = { id: "bob", name: "Bob", email: "bob@firm.test", username: "bob", avatarUrl: null, tenantId: "uk" };
  let granted: unknown[];
  let notified: unknown[];
  let pushed: unknown[];
  let leftRoom: unknown[];

  beforeEach(() => {
    granted = [];
    notified = [];
    pushed = [];
    leftRoom = [];
    (socket as any).emitToUser = (...args: unknown[]) => pushed.push(args);
    (socket as any).removeUserFromCase = (...args: unknown[]) => leftRoom.push(args);
    (CaseShareRepo as any).findOwnedPortfolioCase = async () => ownCase();
    (CaseShareRepo as any).findRecipient = async () => bob;
    (OrganizationRepo as any).grantCaseAccess = async (...args: unknown[]) => (granted.push(args), { id: "a1" });
    (OrganizationRepo as any).writeAudit = async () => ({});
    (NotificationSvc as any).create = async (input: unknown) => (notified.push(input), {});
  });
  afterEach(restore);

  it("shares with a registered user to view, and tells them", async () => {
    await CaseShareSvc.grant("c1", "alice", "bob", "VIEW");
    expect(granted).to.deep.equal([["c1", "bob", "VIEW"]]);
    expect(notified).to.have.length(1);
  });

  it("refuses edit or manage access", async () => {
    expect(await statusOf(() => CaseShareSvc.grant("c1", "alice", "bob", "EDIT"))).to.equal(400);
    expect(await statusOf(() => CaseShareSvc.grant("c1", "alice", "bob", "ADMIN"))).to.equal(400);
    expect(granted).to.deep.equal([]);
  });

  it("refuses a copy of an organization's case", async () => {
    (CaseShareRepo as any).findOwnedPortfolioCase = async () => ownCase({ copiedFromCaseId: "org-case" });
    expect(await statusOf(() => CaseShareSvc.grant("c1", "alice", "bob", "VIEW"))).to.equal(400);
    expect(granted).to.deep.equal([]);
  });

  it("refuses anyone but the owner", async () => {
    (CaseShareRepo as any).findOwnedPortfolioCase = async () => null;
    expect(await statusOf(() => CaseShareSvc.grant("c1", "mallory", "bob", "VIEW"))).to.equal(404);
  });

  it("treats a user on another site like one who isn't registered", async () => {
    (CaseShareRepo as any).findRecipient = async () => ({ ...bob, tenantId: "ph" });
    expect(await statusOf(() => CaseShareSvc.lookup("c1", "alice", "bob@firm.test"))).to.equal(404);
    (CaseShareRepo as any).findRecipient = async () => null;
    expect(await statusOf(() => CaseShareSvc.lookup("c1", "alice", "nobody@firm.test"))).to.equal(404);
  });

  it("refuses sharing with yourself", async () => {
    (CaseShareRepo as any).findRecipient = async () => ({ ...bob, id: "alice" });
    expect(await statusOf(() => CaseShareSvc.grant("c1", "alice", "alice", "VIEW"))).to.equal(400);
  });

  it("looks a recipient up by their exact, normalized email and doesn't return their tenant", async () => {
    let asked: unknown;
    (CaseShareRepo as any).findRecipient = async (where: unknown) => ((asked = where), bob);
    const person = await CaseShareSvc.lookup("c1", "alice", "  Bob@Firm.TEST ");
    expect(asked).to.deep.equal({ email: "bob@firm.test" });
    expect(person).to.not.have.property("tenantId");
  });

  it("tells the recipient's open tabs about a new share", async () => {
    await CaseShareSvc.grant("c1", "alice", "bob", "VIEW");
    expect(pushed).to.deep.equal([["bob", "shared-cases:changed", { caseId: "c1", shared: true }]]);
    expect(leftRoom).to.deep.equal([]);
  });

  it("takes the recipient out of the case's live room when the owner stops sharing, and tells them", async () => {
    (CaseShareRepo as any).removeShare = async () => true;
    await CaseShareSvc.revoke("c1", "alice", "bob");
    expect(leftRoom).to.deep.equal([["bob", "c1"]]);
    expect(pushed).to.deep.equal([["bob", "shared-cases:changed", { caseId: "c1", shared: false }]]);
  });

  it("does the same when the recipient drops the share themselves", async () => {
    (CaseShareRepo as any).removeShare = async () => true;
    await CaseShareSvc.leave("c1", "bob");
    expect(leftRoom).to.deep.equal([["bob", "c1"]]);
    expect(pushed).to.deep.equal([["bob", "shared-cases:changed", { caseId: "c1", shared: false }]]);
  });

  it("pushes nothing when there was no share to remove", async () => {
    (CaseShareRepo as any).removeShare = async () => false;
    expect(await statusOf(() => CaseShareSvc.revoke("c1", "alice", "bob"))).to.equal(404);
    expect(leftRoom).to.deep.equal([]);
    expect(pushed).to.deep.equal([]);
  });

  it("lets a recipient drop a share", async () => {
    (CaseShareRepo as any).removeShare = async () => true;
    await CaseShareSvc.leave("c1", "bob");
    (CaseShareRepo as any).removeShare = async () => false;
    expect(await statusOf(() => CaseShareSvc.leave("c1", "bob"))).to.equal(404);
  });
});
