/** Verify before plan (UK): a new solo lawyer or firm founder gets into the app only once their
 * Lawyer Application has been verified, then chooses a plan or starts the free trial. Lawyers who
 * signed up before it, firm members and PH are never held. No DB: prisma is monkeypatched. */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import prisma from "../src/lib/prisma";
import PlanGateSvc, { planGateOf, type PlanGateFacts } from "../src/services/plan-gate.service";
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
    const original = { findUnique: prisma.user.findUnique, update: prisma.user.update, sub: prisma.paymentPlanSubscription.findFirst };
    let row: any;
    let live: boolean;
    let updates: any[];

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
      (prisma.user as any).findUnique = async () => row;
      (prisma.user as any).update = async (args: any) => {
        updates.push(args);
        return row;
      };
      (prisma.paymentPlanSubscription as any).findFirst = async () => (live ? { id: "sub-1" } : null);
    });
    afterEach(() => {
      (prisma.user as any).findUnique = original.findUnique;
      (prisma.user as any).update = original.update;
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

    it("counts a started trial or a live subscription as a chosen plan", async () => {
      row.planTrialEndsAt = new Date("2026-11-12");
      expect(await PlanGateSvc.stateOf("u1")).to.equal("OPEN");
      row.planTrialEndsAt = null;
      live = true;
      expect(await PlanGateSvc.stateOf("u1")).to.equal("OPEN");
    });

    it("starts a verified solo lawyer's 14-day trial when they choose it", async () => {
      const now = new Date("2026-11-01T10:00:00Z");
      await PlanGateSvc.startWithoutPaying("u1", now);
      expect(updates[0].data).to.deep.equal({ planChosenAt: now, planTrialEndsAt: new Date(now.getTime() + PLAN_TRIAL_DAYS * DAY_MS) });
    });

    it("lets a verified founder in on the unpaid plan, with no trial", async () => {
      row.soloChosenAt = null;
      row.organizationMemberships = [{ role: "OWNER", organization: { isPersonal: false } }];
      const now = new Date("2026-11-01T10:00:00Z");
      await PlanGateSvc.startWithoutPaying("u1", now);
      expect(updates[0].data).to.deep.equal({ planChosenAt: now });
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
  });
});
