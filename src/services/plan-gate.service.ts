import prisma from "../lib/prisma";
import HttpError from "../utils/http-error";
import { DAY_MS, LIVE_SUBSCRIPTION_STATUSES, PLAN_TRIAL_DAYS } from "../constants/plan-trial.constants";

/** OPEN: in, as today. AWAITING_VERIFICATION: the app shows the waiting page. CHOOSE_PLAN: verified,
 * the app shows the plan step (subscribe, or start without paying). */
export type PlanGate = "OPEN" | "AWAITING_VERIFICATION" | "CHOOSE_PLAN";

/** Who the account is in its workspace. NONE: hasn't chosen solo or a firm yet. */
type Workspace = "SOLO" | "FOUNDER" | "MEMBER" | "NONE";

export interface PlanGateFacts {
  role: string;
  /** Set on a UK lawyer's sign-up (User.verifyBeforePlan). */
  verifyBeforePlan: boolean;
  workspace: Workspace;
  /** Their Lawyer Application has been verified at least once (LawyerClientProfile.firstVerifiedAt). */
  everVerified: boolean;
  /** Chose to go on without paying, started a trial, or has a live subscription. */
  planChosen: boolean;
}

/** Only the people who choose and pay for a plan are held: a solo lawyer and a firm's founder. */
export function planGateOf(f: PlanGateFacts): PlanGate {
  if (f.role !== "LAWYER" || !f.verifyBeforePlan || f.workspace === "MEMBER") return "OPEN";
  if (!f.everVerified) return "AWAITING_VERIFICATION";
  return f.planChosen ? "OPEN" : "CHOOSE_PLAN";
}

/**
 * Verify before plan (UK): a lawyer who signed up since it (User.verifyBeforePlan) and works solo or
 * founded a firm gets into the app only once an admin has verified their Lawyer Application, and
 * then chooses a plan: subscribe, or go on without paying (a solo lawyer's free trial starts then,
 * a founder's firm stays on the unpaid plan). Until then AccountLimitsSvc refuses AI, case and
 * client-request work. Lawyers who signed up before it, firm members, PH and other roles are never
 * held. Account approval is separate and unchanged.
 */
export default class PlanGateSvc {
  static async stateOf(userId: string, db: typeof prisma = prisma): Promise<PlanGate> {
    const facts = await PlanGateSvc.factsOf(userId, db);
    return facts ? planGateOf(facts) : "OPEN";
  }

  /** Throws 403 while the lawyer is held: VERIFICATION_REQUIRED, then PLAN_NOT_CHOSEN. */
  static async assertOpen(userId: string, db: typeof prisma = prisma) {
    const state = await PlanGateSvc.stateOf(userId, db);
    if (state === "AWAITING_VERIFICATION") {
      throw new HttpError("Your lawyer application needs to be verified before you can use ilovelawyer.", 403, "VERIFICATION_REQUIRED");
    }
    if (state === "CHOOSE_PLAN") {
      throw new HttpError("Choose a plan, or start your free trial, to start using ilovelawyer.", 403, "PLAN_NOT_CHOSEN");
    }
  }

  /** The plan step's "go on without paying": a verified solo lawyer's free trial starts now
   * (PLAN_TRIAL_DAYS); a verified founder's firm stays on the unpaid plan. Nothing to do once a
   * plan is chosen; refused before verification. */
  static async startWithoutPaying(userId: string, now: Date = new Date()) {
    const facts = await PlanGateSvc.factsOf(userId);
    const state = facts ? planGateOf(facts) : "OPEN";
    if (state === "AWAITING_VERIFICATION") {
      throw new HttpError("Your lawyer application needs to be verified first.", 409, "VERIFICATION_REQUIRED");
    }
    if (state === "OPEN") return;
    await prisma.user.update({
      where: { id: userId },
      data: { planChosenAt: now, ...(facts!.workspace === "SOLO" ? { planTrialEndsAt: new Date(now.getTime() + PLAN_TRIAL_DAYS * DAY_MS) } : {}) },
    });
  }

  /** Null for no such account. A lawyer who isn't held costs this one read: the rest is only asked
   * of someone who is. */
  private static async factsOf(userId: string, db: typeof prisma = prisma): Promise<PlanGateFacts | null> {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        role: true,
        verifyBeforePlan: true,
        planChosenAt: true,
        planTrialEndsAt: true,
        soloChosenAt: true,
        organizationMemberships: { where: { status: "ACCEPTED" }, select: { role: true, organization: { select: { isPersonal: true } } } },
        clientRequestProfile: { select: { firstVerifiedAt: true } },
      },
    });
    if (!user) return null;
    if (user.role !== "LAWYER" || !user.verifyBeforePlan) {
      return { role: user.role, verifyBeforePlan: false, workspace: "NONE", everVerified: false, planChosen: false };
    }
    const membership = (user.organizationMemberships ?? []).find((m) => !m.organization.isPersonal);
    const workspace: Workspace = user.soloChosenAt ? "SOLO" : membership ? (membership.role === "OWNER" ? "FOUNDER" : "MEMBER") : "NONE";
    const facts = { role: user.role, verifyBeforePlan: user.verifyBeforePlan, workspace, everVerified: !!user.clientRequestProfile?.firstVerifiedAt, planChosen: false };
    // The plan only matters to a held lawyer who's verified: anyone else is decided without it.
    if (planGateOf(facts) !== "CHOOSE_PLAN") return facts;
    const chosen =
      !!user.planChosenAt ||
      !!user.planTrialEndsAt ||
      !!(await db.paymentPlanSubscription.findFirst({ where: { userId, status: { in: LIVE_SUBSCRIPTION_STATUSES } }, select: { id: true } }));
    return { ...facts, planChosen: chosen };
  }
}
