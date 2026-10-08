/** The "What changed" modal's date picker: CaseChangeSvc lists the days a case has change summaries
 * on and one day's runs, in the viewer's time zone. Repository and access check monkeypatched. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import CaseChangeSvc, { resolveTimeZone } from "../src/services/case-change.service";
import CaseChangeSummaryRepo from "../src/repositories/case-change-summary.repository";
import CaseAccess from "../src/utils/case-access";
import HttpError from "../src/utils/http-error";

describe("CaseChangeSvc — days", () => {
  const originals = {
    access: CaseAccess.loadAccessibleCase,
    list: CaseChangeSummaryRepo.list,
    listOnDay: CaseChangeSummaryRepo.listOnDay,
    days: CaseChangeSummaryRepo.days,
  };
  let calls: unknown[][];

  beforeEach(() => {
    calls = [];
    (CaseAccess as any).loadAccessibleCase = async () => ({ id: "case-1" });
    (CaseChangeSummaryRepo as any).list = async (...args: unknown[]) => (calls.push(["list", ...args]), []);
    (CaseChangeSummaryRepo as any).listOnDay = async (...args: unknown[]) => (calls.push(["listOnDay", ...args]), []);
    (CaseChangeSummaryRepo as any).days = async (...args: unknown[]) => (calls.push(["days", ...args]), []);
  });

  afterEach(() => {
    (CaseAccess as any).loadAccessibleCase = originals.access;
    (CaseChangeSummaryRepo as any).list = originals.list;
    (CaseChangeSummaryRepo as any).listOnDay = originals.listOnDay;
    (CaseChangeSummaryRepo as any).days = originals.days;
  });

  it("reads one day's runs in the viewer's time zone", async () => {
    await CaseChangeSvc.list("case-1", "user-1", { day: "2026-10-08", tz: "Asia/Manila" });
    expect(calls).to.deep.equal([["listOnDay", "case-1", "2026-10-08", "Asia/Manila", 50]]);
  });

  it("lists the newest runs across days when no day is given", async () => {
    await CaseChangeSvc.list("case-1", "user-1", { limit: 10 });
    expect(calls).to.deep.equal([["list", "case-1", 10]]);
  });

  it("refuses a day that isn't a YYYY-MM-DD date", async () => {
    for (const day of ["8 Oct", "2026-13-40", ["2026-10-08"]]) {
      const err = await CaseChangeSvc.list("case-1", "user-1", { day }).catch((e) => e);
      expect(err).to.be.instanceOf(HttpError);
      expect(err.statusCode).to.equal(400);
    }
  });

  it("groups days in the viewer's time zone, falling back to UTC for a missing or unknown one", async () => {
    await CaseChangeSvc.days("case-1", "user-1", "Europe/London");
    await CaseChangeSvc.days("case-1", "user-1", "Not/AZone");
    expect(calls).to.deep.equal([
      ["days", "case-1", "Europe/London", 366],
      ["days", "case-1", "UTC", 366],
    ]);
    expect(resolveTimeZone(undefined)).to.equal("UTC");
    expect(resolveTimeZone(["Asia/Manila"])).to.equal("UTC");
  });
});
