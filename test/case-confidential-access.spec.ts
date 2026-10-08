/** #346: confidential cases. On a confidential case plain org membership — org ADMIN included —
 * no longer reaches it: only the org OWNER (D5) and people holding a CaseAccess grant (D6). An
 * ordinary case keeps today's rules exactly.
 *
 * No live Postgres. CaseAccess's real where-clauses are run against in-memory cases by a small
 * evaluator for the Prisma filter subset they use (OR, relation filters, `some`, `in`), so this
 * checks the rule itself rather than the shape of the query.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import prisma from "../src/lib/prisma";
import CaseAccess from "../src/utils/case-access";

type Member = { userId: string; status: "ACCEPTED" | "PENDING"; role: "OWNER" | "ADMIN" | "MANAGER" | "MEMBER" };
type Grant = { userId: string; permission: "VIEW" | "EDIT" | "ADMIN" };
type FakeCase = {
  id: string;
  userId: string | null;
  organizationId: string | null;
  confidential: boolean;
  organization: { isPersonal: boolean; createdById: string; members: Member[] } | null;
  accesses: Grant[];
};

/** Prisma `where` semantics for the subset CaseAccess uses. */
function matches(record: any, where: any): boolean {
  return Object.entries(where).every(([key, cond]: [string, any]) => {
    if (key === "OR") return (cond as any[]).some((w) => matches(record, w));
    if (key === "AND") return (cond as any[]).every((w) => matches(record, w));
    const value = record[key];
    if (cond !== null && typeof cond === "object" && !Array.isArray(cond)) {
      if ("some" in cond) return Array.isArray(value) && value.some((item: any) => matches(item, cond.some));
      if ("in" in cond) return cond.in.includes(value);
      if (value === null || value === undefined) return false;
      return matches(value, cond);
    }
    return value === cond;
  });
}

const OWNER = "owner";
const ADMIN = "admin";
const MEMBER = "member";

function orgCase(confidential: boolean, grants: Grant[] = []): FakeCase {
  return {
    id: "case-1",
    userId: MEMBER, // created by the member — attribution only
    organizationId: "org-1",
    confidential,
    organization: {
      isPersonal: false,
      createdById: OWNER,
      members: [
        { userId: OWNER, status: "ACCEPTED", role: "OWNER" },
        { userId: ADMIN, status: "ACCEPTED", role: "ADMIN" },
        { userId: MEMBER, status: "ACCEPTED", role: "MEMBER" },
        { userId: "pending", status: "PENDING", role: "MEMBER" },
      ],
    },
    accesses: grants,
  };
}

describe("CaseAccess — confidential cases", () => {
  const original = prisma.case.findFirst;
  let current: FakeCase;

  beforeEach(() => {
    (prisma.case as any).findFirst = async ({ where }: any) => (matches(current, where) ? current : null);
  });
  afterEach(() => {
    (prisma.case as any).findFirst = original;
  });

  async function rights(c: FakeCase, userId: string) {
    current = c;
    const view = await CaseAccess.loadAccessibleCase(c.id, userId).then(() => true, () => false);
    const edit = await CaseAccess.canEdit(c.id, userId);
    const manage = await CaseAccess.canManageAccess(c.id, userId);
    const listed = matches(c, CaseAccess.visibleWhere(userId));
    return { view, edit, manage, listed };
  }

  const NONE = { view: false, edit: false, manage: false, listed: false };
  const ALL = { view: true, edit: true, manage: true, listed: true };
  const VIEW_ONLY = { view: true, edit: false, manage: false, listed: true };
  const VIEW_EDIT = { view: true, edit: true, manage: false, listed: true };

  describe("an ordinary case keeps today's rules", () => {
    it("org OWNER and ADMIN: everything", async () => {
      expect(await rights(orgCase(false), OWNER)).to.deep.equal(ALL);
      expect(await rights(orgCase(false), ADMIN)).to.deep.equal(ALL);
    });
    it("a plain member: view only", async () => {
      expect(await rights(orgCase(false), MEMBER)).to.deep.equal(VIEW_ONLY);
    });
    it("a member's EDIT grant adds edit; an ADMIN grant adds manage", async () => {
      expect(await rights(orgCase(false, [{ userId: MEMBER, permission: "EDIT" }]), MEMBER)).to.deep.equal(VIEW_EDIT);
      expect(await rights(orgCase(false, [{ userId: MEMBER, permission: "ADMIN" }]), MEMBER)).to.deep.equal(ALL);
    });
    it("a pending invitee or an outsider: nothing", async () => {
      expect(await rights(orgCase(false), "pending")).to.deep.equal(NONE);
      expect(await rights(orgCase(false), "outsider")).to.deep.equal(NONE);
    });
  });

  describe("a confidential case", () => {
    it("the org OWNER keeps everything (D5)", async () => {
      expect(await rights(orgCase(true), OWNER)).to.deep.equal(ALL);
    });
    it("an org ADMIN without a grant is walled off (D6)", async () => {
      expect(await rights(orgCase(true), ADMIN)).to.deep.equal(NONE);
    });
    it("an org ADMIN holding an ADMIN grant gets everything back", async () => {
      expect(await rights(orgCase(true, [{ userId: ADMIN, permission: "ADMIN" }]), ADMIN)).to.deep.equal(ALL);
    });
    it("a plain member is walled off — even the one who created it", async () => {
      expect(await rights(orgCase(true), MEMBER)).to.deep.equal(NONE);
    });
    it("a VIEW grant opens it read-only; EDIT adds edit; ADMIN adds manage", async () => {
      expect(await rights(orgCase(true, [{ userId: MEMBER, permission: "VIEW" }]), MEMBER)).to.deep.equal(VIEW_ONLY);
      expect(await rights(orgCase(true, [{ userId: MEMBER, permission: "EDIT" }]), MEMBER)).to.deep.equal(VIEW_EDIT);
      expect(await rights(orgCase(true, [{ userId: MEMBER, permission: "ADMIN" }]), MEMBER)).to.deep.equal(ALL);
    });
    it("someone else's grant opens nothing for this user", async () => {
      expect(await rights(orgCase(true, [{ userId: ADMIN, permission: "ADMIN" }]), MEMBER)).to.deep.equal(NONE);
    });
  });

  it("a personal-workspace case stays its owner's, confidential or not", async () => {
    const personal: FakeCase = {
      id: "case-p",
      userId: "solo",
      organizationId: "personal-1",
      confidential: true,
      organization: { isPersonal: true, createdById: "solo", members: [] },
      accesses: [],
    };
    expect(await rights(personal, "solo")).to.deep.equal(ALL);
  });

  it("isConfidential reads the flag", async () => {
    const originalUnique = prisma.case.findUnique;
    try {
      (prisma.case as any).findUnique = async () => ({ confidential: true });
      expect(await CaseAccess.isConfidential("case-1")).to.equal(true);
      (prisma.case as any).findUnique = async () => null;
      expect(await CaseAccess.isConfidential("case-1")).to.equal(false);
    } finally {
      (prisma.case as any).findUnique = originalUnique;
    }
  });
});
