/** Who controls a case beyond editing it:
 * - a MANAGER/MEMBER who creates a case gets an EDIT grant on it (ADMIN if they make it
 *   confidential from the start), so they can work on their own matter;
 * - deleting takes edit access *and* being the org OWNER/ADMIN — an EDIT grant alone can't;
 * - a MANAGER manages access on ordinary cases, but like an ADMIN grant holder only gives View or
 *   Edit, never their own access or manage access, and can't lift a confidential wall;
 * - the case list says per row whether the caller can change that case.
 *
 * No live Postgres: the rules' queries are checked by capturing what CaseAccess hands prisma, and
 * the services with CaseAccess and the repos monkeypatched, as in case-access-sharing.spec.ts.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import prisma from "../src/lib/prisma";
import CaseAccess from "../src/utils/case-access";
import HttpError from "../src/utils/http-error";
import CaseSvc from "../src/services/case.service";
import CaseRepo from "../src/repositories/case.repository";
import OrganizationSvc from "../src/services/organization.service";
import OrganizationRepo from "../src/repositories/organization.repository";
import OrganizationMemberRepo from "../src/repositories/organization-member.repository";
import NotificationSvc from "../src/services/notification.service";
import SecurityAuditSvc from "../src/services/security-audit.service";

async function rejection(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to be refused");
}

describe("CaseAccess — delete, manage and list rules", () => {
  const originals = { findFirst: prisma.case.findFirst, findMany: prisma.case.findMany };
  let args: any[];

  beforeEach(() => {
    args = [];
  });

  afterEach(() => {
    (prisma.case as any).findFirst = originals.findFirst;
    (prisma.case as any).findMany = originals.findMany;
  });

  it("assertCanDelete needs edit access and the org OWNER/ADMIN — no grant clause in the second half", async () => {
    (prisma.case as any).findFirst = async (a: any) => {
      args.push(a);
      return { id: "case-1" };
    };
    await CaseAccess.assertCanDelete("case-1", "user-1");

    const [edit, firmAdmin] = args[0].where.AND;
    expect(edit.id).to.equal("case-1");
    expect(edit.OR.some((c: any) => c.accesses)).to.equal(true);
    expect(firmAdmin.OR.some((c: any) => c.accesses), "a grant never lets someone delete").to.equal(false);
    const orgClause = firmAdmin.OR.find((c: any) => c.organization?.members);
    expect(orgClause.organization.members.some).to.deep.equal({ userId: "user-1", status: "ACCEPTED", role: { in: ["OWNER", "ADMIN"] } });
  });

  it("assertCanDelete 404s when nothing matches", async () => {
    (prisma.case as any).findFirst = async () => null;
    const err = await rejection(CaseAccess.assertCanDelete("case-1", "user-1"));
    expect(err.statusCode).to.equal(404);
  });

  it("a MANAGER manages access on ordinary cases only", async () => {
    (prisma.case as any).findFirst = async (a: any) => {
      args.push(a);
      return { id: "case-1" };
    };
    await CaseAccess.assertCanManageAccess("case-1", "user-1");
    const managerClause = args[0].where.OR.find((c: any) => c.organization?.members?.some?.role === "MANAGER");
    expect(managerClause).to.deep.equal({
      confidential: false,
      organization: { members: { some: { userId: "user-1", status: "ACCEPTED", role: "MANAGER" } } },
    });
  });

  it("canManageFully is the org OWNER/ADMIN (or portfolio owner), without grants", async () => {
    (prisma.case as any).findFirst = async (a: any) => {
      args.push(a);
      return null;
    };
    expect(await CaseAccess.canManageFully("case-1", "user-1")).to.equal(false);
    const [byId, firmAdmin] = args[0].where.AND;
    expect(byId).to.deep.equal({ id: "case-1" });
    expect(firmAdmin.OR.some((c: any) => c.accesses)).to.equal(false);
  });

  it("editableIds asks once for the page, with the edit rule, and skips the query for an empty page", async () => {
    (prisma.case as any).findMany = async (a: any) => {
      args.push(a);
      return [{ id: "case-2" }];
    };
    expect([...(await CaseAccess.editableIds([], "user-1"))]).to.deep.equal([]);
    expect(args).to.have.length(0);

    const ids = await CaseAccess.editableIds(["case-1", "case-2"], "user-1");
    expect([...ids]).to.deep.equal(["case-2"]);
    expect(args[0].where.id).to.deep.equal({ in: ["case-1", "case-2"] });
    expect(args[0].where.OR.some((c: any) => c.accesses)).to.equal(true);
  });
});

describe("OrganizationSvc — limits on a MANAGER or ADMIN grant holder", () => {
  const originals = {
    assertCanManageAccess: CaseAccess.assertCanManageAccess,
    canManageAccess: CaseAccess.canManageAccess,
    canManageFully: CaseAccess.canManageFully,
    canEdit: CaseAccess.canEdit,
    canContribute: CaseAccess.canContribute,
    loadAccessibleCase: CaseAccess.loadAccessibleCase,
    findMember: OrganizationMemberRepo.find,
    listMembers: OrganizationMemberRepo.list,
    grantCaseAccess: OrganizationRepo.grantCaseAccess,
    revokeCaseAccess: OrganizationRepo.revokeCaseAccess,
    findCaseAccess: OrganizationRepo.findCaseAccess,
    listCaseAccess: OrganizationRepo.listCaseAccess,
    writeAudit: OrganizationRepo.writeAudit,
    notify: NotificationSvc.create,
    setConfidential: CaseRepo.setConfidential,
    record: SecurityAuditSvc.record,
  };

  const FIRM_ADMIN = "admin-1";
  const MANAGER = "manager-1";
  let grants: Record<string, string>;
  let writes: string[];
  let confidential: boolean;

  beforeEach(() => {
    grants = { "lead-1": "ADMIN", "editor-1": "EDIT" };
    writes = [];
    confidential = false;
    const canManage = new Set([FIRM_ADMIN, MANAGER, "lead-1"]);
    (CaseAccess as any).assertCanManageAccess = async (caseId: string, userId: string) => {
      if (!canManage.has(userId)) throw new HttpError("Case not found or you can't manage its access", 404);
      return { id: caseId, caseName: "Santos v. Reyes", organizationId: "org-1", confidential };
    };
    (CaseAccess as any).canManageAccess = async (_caseId: string, userId: string) => canManage.has(userId);
    (CaseAccess as any).canManageFully = async (_caseId: string, userId: string) => userId === FIRM_ADMIN;
    (CaseAccess as any).canEdit = async () => true;
    (CaseAccess as any).canContribute = async () => true;
    (CaseAccess as any).loadAccessibleCase = async (caseId: string) => ({ id: caseId, organizationId: "org-1", confidential });
    (OrganizationMemberRepo as any).find = async (_orgId: string, userId: string) => ({ userId, status: "ACCEPTED", role: "MEMBER" });
    (OrganizationMemberRepo as any).list = async () => [];
    (OrganizationRepo as any).grantCaseAccess = async (_caseId: string, userId: string, permission: string) => {
      writes.push(`grant:${userId}:${permission}`);
      grants[userId] = permission;
      return { userId, permission };
    };
    (OrganizationRepo as any).revokeCaseAccess = async (_caseId: string, userId: string) => {
      writes.push(`revoke:${userId}`);
      return true;
    };
    (OrganizationRepo as any).findCaseAccess = async (_caseId: string, userId: string) => grants[userId] ?? null;
    (OrganizationRepo as any).listCaseAccess = async () =>
      Object.entries(grants).map(([userId, permission]) => ({ userId, permission, user: { id: userId, email: "", name: userId, username: userId } }));
    (OrganizationRepo as any).writeAudit = async () => {};
    (NotificationSvc as any).create = async () => ({});
    (CaseRepo as any).setConfidential = async (_caseId: string, value: boolean) => {
      writes.push(`confidential:${value}`);
      confidential = value;
    };
    (SecurityAuditSvc as any).record = async () => {};
  });

  afterEach(() => {
    (CaseAccess as any).assertCanManageAccess = originals.assertCanManageAccess;
    (CaseAccess as any).canManageAccess = originals.canManageAccess;
    (CaseAccess as any).canManageFully = originals.canManageFully;
    (CaseAccess as any).canEdit = originals.canEdit;
    (CaseAccess as any).canContribute = originals.canContribute;
    (CaseAccess as any).loadAccessibleCase = originals.loadAccessibleCase;
    (OrganizationMemberRepo as any).find = originals.findMember;
    (OrganizationMemberRepo as any).list = originals.listMembers;
    (OrganizationRepo as any).grantCaseAccess = originals.grantCaseAccess;
    (OrganizationRepo as any).revokeCaseAccess = originals.revokeCaseAccess;
    (OrganizationRepo as any).findCaseAccess = originals.findCaseAccess;
    (OrganizationRepo as any).listCaseAccess = originals.listCaseAccess;
    (OrganizationRepo as any).writeAudit = originals.writeAudit;
    (NotificationSvc as any).create = originals.notify;
    (CaseRepo as any).setConfidential = originals.setConfidential;
    (SecurityAuditSvc as any).record = originals.record;
  });

  it("a MANAGER gives a member View or Edit", async () => {
    await OrganizationSvc.grantAccess("case-1", MANAGER, "member-1", "EDIT");
    expect(writes).to.deep.equal(["grant:member-1:EDIT"]);
  });

  it("a MANAGER can't give manage access", async () => {
    const err = await rejection(OrganizationSvc.grantAccess("case-1", MANAGER, "member-1", "ADMIN"));
    expect(err.statusCode).to.equal(403);
    expect(writes).to.deep.equal([]);
  });

  it("a MANAGER can't raise their own access", async () => {
    const err = await rejection(OrganizationSvc.grantAccess("case-1", MANAGER, MANAGER, "EDIT"));
    expect(err.statusCode).to.equal(403);
    expect(writes).to.deep.equal([]);
  });

  it("an ADMIN grant holder can't change or remove someone else's manage access", async () => {
    grants["lead-2"] = "ADMIN";
    const lowered = await rejection(OrganizationSvc.grantAccess("case-1", "lead-1", "lead-2", "VIEW"));
    const removed = await rejection(OrganizationSvc.revokeAccess("case-1", "lead-1", "lead-2"));
    expect([lowered.statusCode, removed.statusCode]).to.deep.equal([403, 403]);
    expect(writes).to.deep.equal([]);
  });

  it("a MANAGER removes an Edit grant (a creator's included)", async () => {
    await OrganizationSvc.revokeAccess("case-1", MANAGER, "editor-1");
    expect(writes).to.deep.equal(["revoke:editor-1"]);
  });

  it("an org ADMIN gives manage access without limits", async () => {
    await OrganizationSvc.grantAccess("case-1", FIRM_ADMIN, "member-1", "ADMIN");
    expect(writes).to.deep.equal(["grant:member-1:ADMIN"]);
  });

  it("an ADMIN grant holder can put up a confidential wall", async () => {
    await OrganizationSvc.setConfidential("case-1", "lead-1", true);
    expect(writes).to.deep.equal(["grant:lead-1:ADMIN", "confidential:true"]);
  });

  it("a MANAGER without an ADMIN grant can't make a case confidential", async () => {
    const err = await rejection(OrganizationSvc.setConfidential("case-1", MANAGER, true));
    expect(err.statusCode).to.equal(403);
    expect(writes).to.deep.equal([]);
  });

  it("only an org OWNER/ADMIN lifts a confidential wall", async () => {
    confidential = true;
    const err = await rejection(OrganizationSvc.setConfidential("case-1", "lead-1", false));
    expect(err.statusCode).to.equal(403);
    await OrganizationSvc.setConfidential("case-1", FIRM_ADMIN, false);
    expect(writes).to.deep.equal(["confidential:false"]);
  });

  it("listAccess tells the app what the caller may do", async () => {
    expect(await OrganizationSvc.listAccess("case-1", MANAGER)).to.include({ canManage: true, canManageFully: false, canMarkConfidential: false });
    expect(await OrganizationSvc.listAccess("case-1", "lead-1")).to.include({ canManage: true, canManageFully: false, canMarkConfidential: true });
    expect(await OrganizationSvc.listAccess("case-1", FIRM_ADMIN)).to.include({ canManage: true, canManageFully: true, canMarkConfidential: true });
    expect(await OrganizationSvc.listAccess("case-1", "member-1")).to.include({ canManage: false, canManageFully: false, canMarkConfidential: false });
  });
});

describe("CaseSvc.create — the creator's access", () => {
  const originals = {
    create: CaseRepo.create,
    isPersonal: OrganizationRepo.isPersonal,
    grantCaseAccess: OrganizationRepo.grantCaseAccess,
    writeAudit: OrganizationRepo.writeAudit,
    record: SecurityAuditSvc.record,
  };
  let writes: string[];
  let created: any;
  let personal: boolean;

  beforeEach(() => {
    writes = [];
    personal = false;
    (CaseRepo as any).create = async (_orgId: string, userId: string, data: any) => {
      created = { id: "case-new", caseName: data.caseName, userId, ...data };
      writes.push(`create:${data.confidential}`);
      return created;
    };
    (OrganizationRepo as any).isPersonal = async () => personal;
    (OrganizationRepo as any).grantCaseAccess = async (_caseId: string, userId: string, permission: string) => {
      writes.push(`grant:${userId}:${permission}`);
    };
    (OrganizationRepo as any).writeAudit = async (entry: { action: string }) => {
      writes.push(`audit:${entry.action}`);
    };
    (SecurityAuditSvc as any).record = async (entry: { action: string }) => {
      writes.push(`security:${entry.action}`);
    };
  });

  afterEach(() => {
    (CaseRepo as any).create = originals.create;
    (OrganizationRepo as any).isPersonal = originals.isPersonal;
    (OrganizationRepo as any).grantCaseAccess = originals.grantCaseAccess;
    (OrganizationRepo as any).writeAudit = originals.writeAudit;
    (SecurityAuditSvc as any).record = originals.record;
  });

  for (const role of ["MEMBER", "MANAGER"] as const) {
    it(`a ${role} gets an EDIT grant on the case they create, audited`, async () => {
      await CaseSvc.create("org-1", "user-1", role, { caseName: "Santos v. Reyes" });
      expect(writes).to.deep.equal(["create:false", "grant:user-1:EDIT", "audit:case.grant_access", "security:case.access_granted"]);
    });
  }

  for (const role of ["OWNER", "ADMIN"] as const) {
    it(`an ${role} needs no grant — their role already edits it`, async () => {
      await CaseSvc.create("org-1", "user-1", role, { caseName: "Santos v. Reyes" });
      expect(writes).to.deep.equal(["create:false"]);
    });
  }

  it("a case made confidential at creation is walled from the start, and its creator manages it", async () => {
    await CaseSvc.create("org-1", "user-1", "MEMBER", { caseName: "Santos v. Reyes", confidential: true });
    expect(writes).to.deep.equal([
      "create:true",
      "grant:user-1:ADMIN",
      "audit:case.grant_access",
      "security:case.access_granted",
      "audit:case.confidential_set",
      "security:case.confidential_changed",
    ]);
  });

  it("refuses confidential in a personal workspace, creating nothing", async () => {
    personal = true;
    const err = await rejection(CaseSvc.create("org-1", "user-1", "OWNER", { caseName: "Mine", confidential: true }));
    expect(err.statusCode).to.equal(400);
    expect(writes).to.deep.equal([]);
  });
});

describe("CaseSvc.list — per-row canEdit", () => {
  const originals = { list: CaseRepo.list, withCopyContext: CaseRepo.withCopyContext, editableIds: CaseAccess.editableIds };

  afterEach(() => {
    (CaseRepo as any).list = originals.list;
    (CaseRepo as any).withCopyContext = originals.withCopyContext;
    (CaseAccess as any).editableIds = originals.editableIds;
  });

  it("marks each case with whether the caller can change it", async () => {
    (CaseRepo as any).list = async () => ({ total: 2, data: [{ id: "case-1" }, { id: "case-2" }] });
    (CaseRepo as any).withCopyContext = async (rows: any[]) => rows;
    (CaseAccess as any).editableIds = async () => new Set(["case-2"]);

    const result = await CaseSvc.list("org-1", "user-1", 1, 20);
    expect(result.data).to.deep.equal([
      { id: "case-1", canEdit: false },
      { id: "case-2", canEdit: true },
    ]);
  });
});
