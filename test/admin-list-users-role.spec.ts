/** The admin users list splits into the Lawyers and Clients tabs by `role` (LAWYER / USER), and
 * never lists ADMIN accounts either way.
 *
 * No live Postgres: prisma.user's methods are monkeypatched, same idiom as
 * test/users-list-cache.spec.ts.
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import prisma from "../src/lib/prisma";
import AuthRepo from "../src/repositories/auth.repository";
import { listUsersSchema } from "../src/validation/admin.validation";

describe("Admin users list — filter by role", () => {
  let restore: () => void;
  let wheres: unknown[];

  beforeEach(() => {
    wheres = [];
    const user = prisma.user as any;
    const saved = { findMany: user.findMany, count: user.count, $transaction: (prisma as any).$transaction };
    user.findMany = (args: { where: unknown }) => {
      wheres.push(args.where);
      return Promise.resolve([]);
    };
    user.count = () => Promise.resolve(0);
    (prisma as any).$transaction = (queries: Promise<unknown>[]) => Promise.all(queries);
    restore = () => {
      user.findMany = saved.findMany;
      user.count = saved.count;
      (prisma as any).$transaction = saved.$transaction;
    };
  });

  afterEach(() => restore());

  const list = (role?: "LAWYER" | "USER") =>
    AuthRepo.listUsers({ page: 1, limit: 20, sortBy: "createdAt", sortDir: "desc", role });

  it("lists only lawyers for role=LAWYER and only clients for role=USER", async () => {
    await list("LAWYER");
    await list("USER");
    expect(wheres.map((w: any) => w.role)).to.deep.equal(["LAWYER", "USER"]);
  });

  it("lists both, still without admins, when no role is given", async () => {
    await list();
    expect((wheres[0] as any).role).to.deep.equal({ not: "ADMIN" });
  });

  it("accepts LAWYER and USER and refuses ADMIN or anything else", () => {
    expect(listUsersSchema.validate({ role: "LAWYER" }).error).to.equal(undefined);
    expect(listUsersSchema.validate({ role: "USER" }).error).to.equal(undefined);
    expect(listUsersSchema.validate({ role: "ADMIN" }).error).to.not.equal(undefined);
    expect(listUsersSchema.validate({ role: "lawyer" }).error).to.not.equal(undefined);
  });
});
