/** Verify before plan (UK): a new solo lawyer or firm founder gets into the app only once their
 * Lawyer Application has been verified, then chooses a plan or starts the free trial. Lawyers who
 * signed up before it, firm members and PH are never held. No DB: prisma is monkeypatched. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import prisma from "../src/lib/prisma";
import PlanGateSvc, { planGateOf, workspaceOf, type PlanGateFacts } from "../src/services/plan-gate.service";
import { DAY_MS, PLAN_TRIAL_DAYS } from "../src/constants/plan-trial.constants";

const gated: PlanGateFacts = { role: "LAWYER", verifyBeforePlan: true, workspace: "SOLO", everVerified: false, planChosen: false };

async function errorOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (err: any) {
    return { status: err.status ?? err.statusCode, code: err.code };
  }
  return null;
}

describe("Plan gate (verify before plan)", () => {
  describe("planGateOf", () => {
    it("holds a new solo lawyer or founder until their application has been verified", () => {
      expect(planGateOf(gated)).to.equal("AWAITING_VERIFICATION");
      expect(planGateOf({ ...gated, workspace: "FOUNDER" })).to.equal("AWAITING_VERIFICATION");
      // Still choosing solo or firm: setup comes first, and they can't be in yet.
      expect(planGateOf({ ...gated, workspace: "NONE" })).to.equal("AWAITING_VERIFICATION");
    });

    it("asks for a plan once verified, and lets them in once one is chosen", () => {
      expect(planGateOf({ ...gated, everVerified: true })).to.equal("CHOOSE_PLAN");
      expect(planGateOf({ ...gated, everVerified: true, planChosen: true })).to.equal("OPEN");
    });

    it("never holds a lawyer who signed up before it, a firm member, or another role", () => {
      expect(planGateOf({ ...gated, verifyBeforePlan: false })).to.equal("OPEN");
      expect(planGateOf({ ...gated, workspace: "MEMBER" })).to.equal("OPEN");
      expect(planGateOf({ ...gated, role: "USER" })).to.equal("OPEN");
    });
  });

  describe("PlanGateSvc", () => {
    const original = { findUnique: prisma.user.findUnique, updateMany: prisma.user.updateMany, sub: prisma.paymentPlanSubscription.findFirst };
    let row: any;
    let live: boolean;
    let updates: any[];
    /** What the conditional write does: by default it matches and applies its data to the row. */
    let writeMatches: boolean;

    beforeEach(() => {
      row = {
        role: "LAWYER",
        verifyBeforePlan: true,
        planChosenAt: null,
        planTrialEndsAt: null,
        soloChosenAt: new Date("2026-10-28"),
        organizationMemberships: [],
        clientRequestProfile: { firstVerifiedAt: new Date("2026-10-29") },
      };
      live = false;
      updates = [];
      writeMatches = true;
      (prisma.user as any).findUnique = async () => row;
      (prisma.user as any).updateMany = async (args: any) => {
        updates.push(args);
        if (!writeMatches) return { count: 0 };
        Object.assign(row, args.data);
        return { count: 1 };
      };
      (prisma.paymentPlanSubscription as any).findFirst = async () => (live ? { id: "sub-1" } : null);
    });
    afterEach(() => {
      (prisma.user as any).findUnique = original.findUnique;
      (prisma.user as any).updateMany = original.updateMany;
      (prisma.paymentPlanSubscription as any).findFirst = original.sub;
    });

    it("reads a solo lawyer, a founder and a member from the account", async () => {
      expect(await PlanGateSvc.stateOf("u1")).to.equal("CHOOSE_PLAN");
      row.soloChosenAt = null;
      row.organizationMemberships = [{ role: "OWNER", organization: { isPersonal: false } }];
      expect(await PlanGateSvc.stateOf("u1")).to.equal("CHOOSE_PLAN");
      row.organizationMemberships = [{ role: "MEMBER", organization: { isPersonal: false } }];
      expect(await PlanGateSvc.stateOf("u1")).to.equal("OPEN");
    });

    it("lets a firm decide the workspace: solo then joined a firm is a member, and owning any firm is a founder", () => {
      const member = { role: "MEMBER", organization: { isPersonal: false } };
      const owner = { role: "OWNER", organization: { isPersonal: false } };
      const personal = { role: "OWNER", organization: { isPersonal: true } };
      const solo = new Date("2026-10-28");
      expect(workspaceOf(solo, [member])).to.equal("MEMBER");
      expect(workspaceOf(null, [member, owner])).to.equal("FOUNDER");
      expect(workspaceOf(null, [owner, member])).to.equal("FOUNDER");
      expect(workspaceOf(solo, [personal])).to.equal("SOLO");
      expect(workspaceOf(null, [])).to.equal("NONE");
    });

    it("counts a started trial or a live subscription as a chosen plan", async () => {
      row.planTrialEndsAt = new Date("2026-11-12");
      expect(await PlanGateSvc.stateOf("u1")).to.equal("OPEN");
      row.planTrialEndsAt = null;
      live = true;
      expect(await PlanGateSvc.stateOf("u1")).to.equal("OPEN");
    });

    it("starts a verified solo lawyer's 14-day trial when they choose it, under the trial's own guards", async () => {
      const now = new Date("2026-11-01T10:00:00Z");
      await PlanGateSvc.startWithoutPaying("u1", now);
      expect(updates).to.have.length(1);
      expect(updates[0].where).to.deep.include({ id: "u1", verifyBeforePlan: true, approvalStatus: "ACTIVE", trialExpiresAt: null, planTrialEndsAt: null });
      expect(updates[0].data).to.deep.equal({ planTrialEndsAt: new Date(now.getTime() + PLAN_TRIAL_DAYS * DAY_MS), planChosenAt: now });
    });

    it("lets a verified founder in on the unpaid plan, with no trial, once their account is approved", async () => {
      row.soloChosenAt = null;
      row.organizationMemberships = [{ role: "OWNER", organization: { isPersonal: false } }];
      const now = new Date("2026-11-01T10:00:00Z");
      await PlanGateSvc.startWithoutPaying("u1", now);
      expect(updates[0].where).to.deep.equal({ id: "u1", verifyBeforePlan: true, approvalStatus: "ACTIVE", planChosenAt: null });
      expect(updates[0].data).to.deep.equal({ planChosenAt: now });
    });

    it("refuses before they've chosen solo or a firm, so no one is let in without a trial", async () => {
      row.soloChosenAt = null;
      expect(await errorOf(PlanGateSvc.startWithoutPaying("u1"))).to.deep.equal({ status: 409, code: "WORKSPACE_REQUIRED" });
      expect(updates).to.deep.equal([]);
    });

    it("refuses when the trial can't start (the account isn't approved), rather than letting them in", async () => {
      writeMatches = false;
      expect(await errorOf(PlanGateSvc.startWithoutPaying("u1"))).to.deep.equal({ status: 409, code: "PLAN_NOT_STARTED" });
    });

    it("succeeds for the second of two requests at once, which finds the trial already started", async () => {
      writeMatches = false;
      const realFind = (prisma.user as any).findUnique;
      let reads = 0;
      (prisma.user as any).findUnique = async () => {
        // The first request's write lands between this one's read and its own write.
        if (++reads > 1) row.planTrialEndsAt = new Date("2026-11-15");
        return realFind();
      };
      expect(await errorOf(PlanGateSvc.startWithoutPaying("u1"))).to.equal(null);
    });

    it("refuses before verification, and does nothing once a plan is chosen", async () => {
      row.clientRequestProfile = { firstVerifiedAt: null };
      expect(await errorOf(PlanGateSvc.startWithoutPaying("u1"))).to.deep.equal({ status: 409, code: "VERIFICATION_REQUIRED" });
      row.clientRequestProfile = { firstVerifiedAt: new Date() };
      row.planChosenAt = new Date();
      await PlanGateSvc.startWithoutPaying("u1");
      expect(updates).to.deep.equal([]);
    });

    it("refuses AI and case work while held, with a code the app can act on", async () => {
      row.clientRequestProfile = { firstVerifiedAt: null };
      expect(await errorOf(PlanGateSvc.assertOpen("u1"))).to.deep.equal({ status: 403, code: "VERIFICATION_REQUIRED" });
      row.clientRequestProfile = { firstVerifiedAt: new Date() };
      expect(await errorOf(PlanGateSvc.assertOpen("u1"))).to.deep.equal({ status: 403, code: "PLAN_NOT_CHOSEN" });
      row.planChosenAt = new Date();
      expect(await errorOf(PlanGateSvc.assertOpen("u1"))).to.equal(null);
    });

    it("costs a lawyer who isn't held one small read and nothing more", async () => {
      row.verifyBeforePlan = false;
      let subChecks = 0;
      (prisma.paymentPlanSubscription as any).findFirst = async () => {
        subChecks++;
        return null;
      };
      expect(await PlanGateSvc.stateOf("u1")).to.equal("OPEN");
      expect(subChecks).to.equal(0);
    });

    it("checks every request from a held lawyer, and remembers an account that can never be held", async () => {
      row.clientRequestProfile = { firstVerifiedAt: null };
      expect(await errorOf(PlanGateSvc.assertOpenForRequest("held-1"))).to.deep.equal({ status: 403, code: "VERIFICATION_REQUIRED" });
      expect(await errorOf(PlanGateSvc.assertOpenForRequest("held-1"))).to.deep.equal({ status: 403, code: "VERIFICATION_REQUIRED" });

      row.verifyBeforePlan = false;
      let reads = 0;
      (prisma.user as any).findUnique = async () => {
        reads++;
        return row;
      };
      await PlanGateSvc.assertOpenForRequest("never-held-1");
      await PlanGateSvc.assertOpenForRequest("never-held-1");
      expect(reads).to.equal(1);
    });
  });
});
