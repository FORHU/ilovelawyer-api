import prisma from "../lib/prisma";
import AuthRepo from "../repositories/auth.repository";
import HttpError from "../utils/http-error";

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

/** A firm decides first, whatever the order the rows come in: owning one makes them a founder (who
 * chooses its plan), otherwise belonging to one makes them a member (the firm pays). Only a lawyer
 * in no firm is solo, so one who chose solo and later joined a firm is a member. */
export function workspaceOf(soloChosenAt: Date | null, memberships: { role: string; organization: { isPersonal: boolean } }[]): Workspace {
  const firms = memberships.filter((m) => !m.organization.isPersonal);
  if (firms.some((m) => m.role === "OWNER")) return "FOUNDER";
  if (firms.length) return "MEMBER";
  return soloChosenAt ? "SOLO" : "NONE";
}

/** Accounts that are never held: User.verifyBeforePlan is set at sign-up and never changes, so once
 * it's read as false the request gate (assertOpenForRequest) needn't ask again. Cleared when full,
 * which only costs a re-read. */
const NEVER_HELD = new Set<string>();
const NEVER_HELD_MAX = 50_000;

/**
 * Verify before plan (UK): a lawyer who signed up since it (User.verifyBeforePlan) and works solo or
 * founded a firm gets into the app only once an admin has verified their Lawyer Application, and
 * then chooses a plan: subscribe, or go on without paying (a solo lawyer's free trial starts then,
 * a founder's firm stays on the unpaid plan). Until then the API refuses everything but what the
 * verification and plan steps need (planGate middleware). Lawyers who signed up before it, firm
 * members, PH and other roles are never held. Account approval is separate and unchanged.
 */
export default class PlanGateSvc {
  static async stateOf(userId: string, db: typeof prisma = prisma): Promise<PlanGate> {
    const facts = await PlanGateSvc.factsOf(userId, db);
    return facts ? planGateOf(facts) : "OPEN";
  }

  /** Throws 403 while the lawyer is held: VERIFICATION_REQUIRED, then PLAN_NOT_CHOSEN. */
  static async assertOpen(userId: string, db: typeof prisma = prisma) {
    PlanGateSvc.throwIfHeld(await PlanGateSvc.stateOf(userId, db));
  }

  /** assertOpen for every API request (planGate middleware): an account that can never be held is
   * remembered, so it costs one read per process rather than one per request. */
  static async assertOpenForRequest(userId: string) {
    if (NEVER_HELD.has(userId)) return;
    const facts = await PlanGateSvc.factsOf(userId);
    if (!facts) return;
    if (!facts.verifyBeforePlan) {
      if (NEVER_HELD.size >= NEVER_HELD_MAX) NEVER_HELD.clear();
      NEVER_HELD.add(userId);
      return;
    }
    PlanGateSvc.throwIfHeld(planGateOf(facts));
  }

  /** The plan step's "go on without paying": a verified solo lawyer's free trial starts now
   * (PLAN_TRIAL_DAYS, under AuthRepo.startPlanTrial's guards); a verified founder's firm stays on
   * the unpaid plan. Nothing to do once a plan is chosen; refused before verification, and before
   * they've chosen solo or a firm — the trial is the solo lawyer's, so it can't be decided yet.
   * Both writes are conditional: two requests at once start it once. */
  static async startWithoutPaying(userId: string, now: Date = new Date()) {
    const facts = await PlanGateSvc.factsOf(userId);
    const state = facts ? planGateOf(facts) : "OPEN";
    if (state === "AWAITING_VERIFICATION") {
      throw new HttpError("Your lawyer application needs to be verified first.", 409, "VERIFICATION_REQUIRED");
    }
    if (state === "OPEN") return;
    if (facts!.workspace === "NONE") {
      throw new HttpError("Choose whether you work solo or as a firm first.", 409, "WORKSPACE_REQUIRED");
    }
    const started =
      facts!.workspace === "SOLO"
        ? await AuthRepo.startPlanTrial(userId, now, { chosenAfterVerification: true })
        : (await prisma.user.updateMany({ where: { id: userId, verifyBeforePlan: true, approvalStatus: "ACTIVE", planChosenAt: null }, data: { planChosenAt: now } })).count > 0;
    // Not started: another request got there first (now OPEN), or the account isn't approved.
    if (!started && (await PlanGateSvc.stateOf(userId)) !== "OPEN") {
      throw new HttpError("Your plan couldn't be started. Your account needs to be approved first.", 409, "PLAN_NOT_STARTED");
    }
  }

  private static throwIfHeld(state: PlanGate) {
    if (state === "AWAITING_VERIFICATION") {
      throw new HttpError("Your lawyer application needs to be verified before you can use ilovelawyer.", 403, "VERIFICATION_REQUIRED");
    }
    if (state === "CHOOSE_PLAN") {
      throw new HttpError("Choose a plan, or start your free trial, to start using ilovelawyer.", 403, "PLAN_NOT_CHOSEN");
    }
  }

  /** Null for no such account. A lawyer who isn't held costs this one read: the rest is only asked
   * of someone who is. `verifyBeforePlan` is the account's own flag, whatever its role. */
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
      return { role: user.role, verifyBeforePlan: user.verifyBeforePlan, workspace: "NONE", everVerified: false, planChosen: false };
    }
    const workspace = workspaceOf(user.soloChosenAt, user.organizationMemberships ?? []);
    const facts = { role: user.role, verifyBeforePlan: user.verifyBeforePlan, workspace, everVerified: !!user.clientRequestProfile?.firstVerifiedAt, planChosen: false };
    // The plan only matters to a held lawyer who's verified: anyone else is decided without it.
    if (planGateOf(facts) !== "CHOOSE_PLAN") return facts;
    const chosen = !!user.planChosenAt || !!user.planTrialEndsAt || (await AuthRepo.hasLiveSubscription(userId, db));
    return { ...facts, planChosen: chosen };
  }
}
