/** #347: per-case sharing — grant, revoke and list CaseAccess grants.
 *
 * Who may share (product decision D3 on #331): an org OWNER/ADMIN, or a holder of an ADMIN grant
 * on the case — never an EDIT holder, who before this could grant anyone (themselves included)
 * ADMIN. In v1 a grant can only go to an accepted member of the case's own organization.
 *
 * No live Postgres: the rule's query is checked by capturing what CaseAccess hands
 * prisma.case.findFirst; the services are checked with CaseAccess and the repos monkeypatched,
 * same idiom as case-destructive-access.spec.ts.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import prisma from "../src/lib/prisma";
import CaseAccess from "../src/utils/case-access";
import HttpError from "../src/utils/http-error";
import OrganizationSvc from "../src/services/organization.service";
import OrganizationRepo from "../src/repositories/organization.repository";
import OrganizationMemberRepo from "../src/repositories/organization-member.repository";
import NotificationSvc from "../src/services/notification.service";
import CaseRepo from "../src/repositories/case.repository";
import SecurityAuditSvc from "../src/services/security-audit.service";

async function rejection(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to be refused");
}

describe("CaseAccess.assertCanManageAccess — who may share a case", () => {
  const original = prisma.case.findFirst;
  let where: any;

  afterEach(() => {
    (prisma.case as any).findFirst = original;
  });

  it("accepts the case owner, an ADMIN grant, or org OWNER/ADMIN — and not an EDIT grant", async () => {
    (prisma.case as any).findFirst = async (args: any) => {
      where = args.where;
      return { id: "case-1", caseName: "Case", organizationId: "org-1" };
    };

    await CaseAccess.assertCanManageAccess("case-1", "user-1");

    expect(where.id).to.equal("case-1");
    const grantClause = where.OR.find((c: any) => c.accesses);
    expect(grantClause.accesses.some).to.deep.equal({ userId: "user-1", permission: "ADMIN" });
    const orgClause = where.OR.find((c: any) => c.organization?.members);
    expect(orgClause.organization.members.some).to.deep.equal({
      userId: "user-1",
      status: "ACCEPTED",
      role: { in: ["OWNER", "ADMIN"] },
    });
  });

  it("404s when no clause matches", async () => {
    (prisma.case as any).findFirst = async () => null;
    const err = await rejection(CaseAccess.assertCanManageAccess("case-1", "user-1"));
    expect(err.statusCode).to.equal(404);
  });

  it("canManageAccess answers the same question as a boolean", async () => {
    (prisma.case as any).findFirst = async () => ({ id: "case-1" });
    expect(await CaseAccess.canManageAccess("case-1", "user-1")).to.equal(true);
    (prisma.case as any).findFirst = async () => null;
    expect(await CaseAccess.canManageAccess("case-1", "user-1")).to.equal(false);
  });
});

describe("OrganizationSvc — case sharing", () => {
  const originals = {
    assertCanManageAccess: CaseAccess.assertCanManageAccess,
    canManageAccess: CaseAccess.canManageAccess,
    canEdit: CaseAccess.canEdit,
    loadAccessibleCase: CaseAccess.loadAccessibleCase,
    findMember: OrganizationMemberRepo.find,
    listMembers: OrganizationMemberRepo.list,
    grantCaseAccess: OrganizationRepo.grantCaseAccess,
    revokeCaseAccess: OrganizationRepo.revokeCaseAccess,
    listCaseAccess: OrganizationRepo.listCaseAccess,
    writeAudit: OrganizationRepo.writeAudit,
    notify: NotificationSvc.create,
    setConfidential: CaseRepo.setConfidential,
    record: SecurityAuditSvc.record,
  };

  const MANAGER = "manager-1";
  /** Users allowed to manage access on case-1. */
  let managers: Set<string>;
  let members: Record<string, { status: string; role: string }>;
  let grants: { userId: string; permission: string }[];
  let writes: string[];
  /** What reached the security audit log (#391). */
  let audits: any[];
  /** The case's confidential flag, as the stubbed assertCanManageAccess reports it. */
  let confidential: boolean;

  beforeEach(() => {
    managers = new Set([MANAGER]);
    members = {
      [MANAGER]: { status: "ACCEPTED", role: "ADMIN" },
      "member-1": { status: "ACCEPTED", role: "MEMBER" },
      "pending-1": { status: "PENDING", role: "MEMBER" },
    };
    grants = [];
    writes = [];
    audits = [];
    (SecurityAuditSvc as any).record = async (entry: object) => {
      audits.push(entry);
    };

    (CaseAccess as any).assertCanManageAccess = async (caseId: string, userId: string) => {
      if (!managers.has(userId)) throw new HttpError("Case not found or you can't manage its access", 404);
      return { id: caseId, caseName: "Santos v. Reyes", organizationId: "org-1", confidential };
    };
    (CaseAccess as any).canManageAccess = async (_caseId: string, userId: string) => managers.has(userId);
    (CaseAccess as any).canEdit = async (_caseId: string, userId: string) => managers.has(userId) || userId === "editor-1";
    (CaseAccess as any).loadAccessibleCase = async (caseId: string) => ({ id: caseId, organizationId: "org-1", confidential });
    (OrganizationMemberRepo as any).find = async (organizationId: string, userId: string) =>
      organizationId === "org-1" && members[userId] ? { userId, organizationId, ...members[userId] } : null;
    (OrganizationMemberRepo as any).list = async () =>
      Object.entries(members).map(([userId, m]) => ({
        userId,
        ...m,
        user: { id: userId, name: userId, email: `${userId}@example.com`, username: userId, avatarUrl: null },
      }));
    (OrganizationRepo as any).grantCaseAccess = async (caseId: string, userId: string, permission: string) => {
      writes.push(`grant:${userId}:${permission}`);
      return { caseId, userId, permission };
    };
    (OrganizationRepo as any).revokeCaseAccess = async (_caseId: string, userId: string) => {
      const had = grants.some((g) => g.userId === userId);
      if (had) writes.push(`revoke:${userId}`);
      return had;
    };
    (OrganizationRepo as any).listCaseAccess = async () =>
      grants.map((g) => ({ ...g, user: { id: g.userId, name: g.userId, email: `${g.userId}@example.com`, username: g.userId } }));
    (OrganizationRepo as any).writeAudit = async (entry: { action: string }) => {
      writes.push(`audit:${entry.action}`);
    };
    (NotificationSvc as any).create = async () => ({});
    confidential = false;
    (CaseRepo as any).setConfidential = async (_caseId: string, value: boolean) => {
      writes.push(`confidential:${value}`);
      confidential = value;
    };
  });

  afterEach(() => {
    (CaseAccess as any).assertCanManageAccess = originals.assertCanManageAccess;
    (CaseAccess as any).canManageAccess = originals.canManageAccess;
    (CaseAccess as any).canEdit = originals.canEdit;
    (CaseAccess as any).loadAccessibleCase = originals.loadAccessibleCase;
    (OrganizationMemberRepo as any).find = originals.findMember;
    (OrganizationMemberRepo as any).list = originals.listMembers;
    (OrganizationRepo as any).grantCaseAccess = originals.grantCaseAccess;
    (OrganizationRepo as any).revokeCaseAccess = originals.revokeCaseAccess;
    (OrganizationRepo as any).listCaseAccess = originals.listCaseAccess;
    (OrganizationRepo as any).writeAudit = originals.writeAudit;
    (NotificationSvc as any).create = originals.notify;
    (CaseRepo as any).setConfidential = originals.setConfidential;
    (SecurityAuditSvc as any).record = originals.record;
  });

  describe("grantAccess", () => {
    it("lets a manager grant an accepted member, with an audit entry", async () => {
      await OrganizationSvc.grantAccess("case-1", MANAGER, "member-1", "EDIT");
      expect(writes).to.deep.equal(["grant:member-1:EDIT", "audit:case.grant_access"]);
    });

    it("refuses someone who can't manage the case's access (e.g. an EDIT holder) before writing", async () => {
      const err = await rejection(OrganizationSvc.grantAccess("case-1", "member-1", "member-1", "ADMIN"));
      expect(err.statusCode).to.equal(404);
      expect(writes).to.deep.equal([]);
    });

    it("refuses a user who isn't in the case's organization", async () => {
      const err = await rejection(OrganizationSvc.grantAccess("case-1", MANAGER, "outsider-1", "VIEW"));
      expect(err.statusCode).to.equal(400);
      expect(writes).to.deep.equal([]);
    });

    it("refuses a member whose invite isn't accepted yet", async () => {
      const err = await rejection(OrganizationSvc.grantAccess("case-1", MANAGER, "pending-1", "VIEW"));
      expect(err.statusCode).to.equal(400);
      expect(writes).to.deep.equal([]);
    });

    it("refuses a case with no organization to share within", async () => {
      (CaseAccess as any).assertCanManageAccess = async () => ({ id: "case-1", caseName: "Case", organizationId: null });
      const err = await rejection(OrganizationSvc.grantAccess("case-1", MANAGER, "member-1", "VIEW"));
      expect(err.statusCode).to.equal(400);
      expect(writes).to.deep.equal([]);
    });
  });

  describe("revokeAccess", () => {
    it("lets a manager remove a grant, with an audit entry", async () => {
      grants = [{ userId: "member-1", permission: "EDIT" }];
      await OrganizationSvc.revokeAccess("case-1", MANAGER, "member-1");
      expect(writes).to.deep.equal(["revoke:member-1", "audit:case.revoke_access"]);
    });

    it("records the revoke in the security audit log, naming who lost access (#391)", async () => {
      grants = [{ userId: "member-1", permission: "EDIT" }];
      await OrganizationSvc.revokeAccess("case-1", MANAGER, "member-1");
      expect(audits).to.deep.equal([
        { action: "case.access_revoked", actorId: MANAGER, organizationId: "org-1", targetType: "user", targetId: "member-1", caseId: "case-1" },
      ]);
    });

    it("refuses someone who can't manage the case's access", async () => {
      grants = [{ userId: "member-1", permission: "EDIT" }];
      const err = await rejection(OrganizationSvc.revokeAccess("case-1", "member-1", "member-1"));
      expect(err.statusCode).to.equal(404);
      expect(writes).to.deep.equal([]);
      expect(audits).to.deep.equal([]);
    });

    it("404s when there's no grant to remove (access from an org role isn't a grant)", async () => {
      const err = await rejection(OrganizationSvc.revokeAccess("case-1", MANAGER, MANAGER));
      expect(err.statusCode).to.equal(404);
      expect(writes).to.deep.equal([]);
      expect(audits).to.deep.equal([]);
    });
  });

  describe("listAccess", () => {
    it("lists each accepted member with their org role and grant, and whether the caller can manage", async () => {
      grants = [{ userId: "member-1", permission: "EDIT" }];
      const result = await OrganizationSvc.listAccess("case-1", MANAGER);

      expect(result.canManage).to.equal(true);
      const byId = Object.fromEntries(result.people.map((p) => [p.userId, p]));
      expect(byId[MANAGER]).to.include({ orgRole: "ADMIN", grant: null });
      expect(byId["member-1"]).to.include({ orgRole: "MEMBER", grant: "EDIT" });
      expect(byId["pending-1"], "pending invitees aren't on the case").to.equal(undefined);
    });

    it("still shows a grant held by someone no longer in the organization, with no org role", async () => {
      grants = [{ userId: "former-1", permission: "VIEW" }];
      const result = await OrganizationSvc.listAccess("case-1", MANAGER);
      const former = result.people.find((p) => p.userId === "former-1");
      expect(former).to.include({ orgRole: null, grant: "VIEW" });
    });

    it("tells a viewer who can't manage that they can't", async () => {
      const result = await OrganizationSvc.listAccess("case-1", "member-1");
      expect(result.canManage).to.equal(false);
      expect(result.canEdit).to.equal(false);
    });

    it("tells a member holding an EDIT grant they can edit but not manage", async () => {
      const result = await OrganizationSvc.listAccess("case-1", "editor-1");
      expect(result).to.include({ canEdit: true, canManage: false });
    });

    it("needs view access to the case", async () => {
      (CaseAccess as any).loadAccessibleCase = async () => {
        throw new HttpError("Case not found", 404);
      };
      const err = await rejection(OrganizationSvc.listAccess("case-1", "stranger-1"));
      expect(err.statusCode).to.equal(404);
    });
  });
  describe("setConfidential", () => {
    it("marking it gives the marker an ADMIN grant first, then sets the flag, with an audit entry (D7/D8)", async () => {
      const result = await OrganizationSvc.setConfidential("case-1", MANAGER, true);
      expect(result).to.deep.equal({ confidential: true });
      expect(writes).to.deep.equal([`grant:${MANAGER}:ADMIN`, "confidential:true", "audit:case.confidential_set"]);
    });

    it("unmarking it clears the flag, with an audit entry, and leaves grants as they are", async () => {
      confidential = true;
      await OrganizationSvc.setConfidential("case-1", MANAGER, false);
      expect(writes).to.deep.equal(["confidential:false", "audit:case.confidential_unset"]);
    });

    it("records marking and unmarking in the security audit log, with the before and after (#391)", async () => {
      await OrganizationSvc.setConfidential("case-1", MANAGER, true);
      await OrganizationSvc.setConfidential("case-1", MANAGER, false);
      const base = { action: "case.confidential_changed", actorId: MANAGER, organizationId: "org-1", targetType: "case", targetId: "case-1", targetName: "Santos v. Reyes", caseId: "case-1" };
      expect(audits).to.deep.equal([
        { ...base, payload: { from: false, to: true } },
        { ...base, payload: { from: true, to: false } },
      ]);
    });

    it("refuses someone who can't manage the case's access, changing nothing", async () => {
      const err = await rejection(OrganizationSvc.setConfidential("case-1", "member-1", true));
      expect(err.statusCode).to.equal(404);
      expect(writes).to.deep.equal([]);
      expect(audits).to.deep.equal([]);
    });

    it("is a no-op when the flag already has that value", async () => {
      confidential = true;
      await OrganizationSvc.setConfidential("case-1", MANAGER, true);
      expect(writes).to.deep.equal([]);
      expect(audits).to.deep.equal([]);
    });
  });

  it("listAccess reports whether the case is confidential", async () => {
    confidential = true;
    const result = await OrganizationSvc.listAccess("case-1", MANAGER);
    expect(result.confidential).to.equal(true);
  });
});
