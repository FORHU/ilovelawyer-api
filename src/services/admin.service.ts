import { ApprovalStatus } from "@prisma/client";
import AuthRepo from "../repositories/auth.repository";
import HttpError from "../utils/http-error";
import { sendEmail } from "../utils/mailer";
import { renderTemplate } from "../utils/template";
import { redis } from "../lib/redis";

const USERS_LIST_CACHE_TTL_S = 60;
const USERS_LIST_VERSION_KEY = "admin:users:version";

export interface ListUsersParams {
  page: number;
  limit: number;
  sortBy: "name" | "email" | "createdAt" | "lastLoginAt";
  sortDir: "asc" | "desc";
  q?: string;
}

// State machine (see schema.prisma's ApprovalStatus comment for the full diagram):
//   PENDING  --approve-->    ACTIVE
//   PENDING  --deny-->       DENIED
//   DENIED   --reactivate--> ACTIVE
//   ACTIVE   --block-->      BLOCKED
//   BLOCKED  --unblock-->    ACTIVE
// Every other (from, to) pair is rejected with 409 — e.g. approving an already-ACTIVE
// user, or blocking a PENDING one.
interface TransitionSpec {
  from: ApprovalStatus;
  to: ApprovalStatus;
  template: string;
  subject: string;
}

const TRANSITIONS: Record<string, TransitionSpec> = {
  approve: { from: "PENDING", to: "ACTIVE", template: "signup-approved", subject: "Your ilovelawyer account has been approved" },
  deny: { from: "PENDING", to: "DENIED", template: "signup-denied", subject: "Your ilovelawyer signup" },
  reactivate: { from: "DENIED", to: "ACTIVE", template: "signup-reactivated", subject: "Your ilovelawyer account has been reactivated" },
  block: { from: "ACTIVE", to: "BLOCKED", template: "account-blocked", subject: "Your ilovelawyer account has been blocked" },
  unblock: { from: "BLOCKED", to: "ACTIVE", template: "account-unblocked", subject: "Your ilovelawyer account has been unblocked" },
};

export default class AdminSvc {
  static async listUsers(params: ListUsersParams) {
    const version = (await redis.get<number>(USERS_LIST_VERSION_KEY)) ?? 0;
    const cacheKey = `admin:users:v${version}:${JSON.stringify(params)}`;

    const cached = await redis.get<{ data: unknown; total: number }>(cacheKey);
    if (cached) return cached;

    const result = await AuthRepo.listUsers(params);
    await redis.set(cacheKey, result, USERS_LIST_CACHE_TTL_S);
    return result;
  }

  /** Orphans every cached users-list page in one write, instead of scanning/deleting each cache key. */
  private static bustUsersListCache() {
    return redis.incr(USERS_LIST_VERSION_KEY);
  }

  private static async transition(action: keyof typeof TRANSITIONS, userId: string, reason?: string) {
    const spec = TRANSITIONS[action];
    const user = await AuthRepo.findById(userId);
    if (!user) throw new HttpError("User not found", 404);

    if (user.approvalStatus !== spec.from) {
      throw new HttpError(
        `Cannot ${action}: account is ${user.approvalStatus}, not ${spec.from}`,
        409
      );
    }

    const updated = await AuthRepo.setApprovalStatus(userId, spec.to, spec.to === "DENIED" ? (reason ?? null) : null);
    await AdminSvc.bustUsersListCache();

    const html = await renderTemplate(spec.template, { name: user.name || "there", reason: reason ?? "" });
    await sendEmail({ to: user.email, subject: spec.subject, html });

    return updated;
  }

  static async approve(userId: string) {
    return AdminSvc.transition("approve", userId);
  }

  static async deny(userId: string, reason?: string) {
    return AdminSvc.transition("deny", userId, reason);
  }

  static async reactivate(userId: string) {
    return AdminSvc.transition("reactivate", userId);
  }

  static async block(userId: string) {
    return AdminSvc.transition("block", userId);
  }

  static async unblock(userId: string) {
    return AdminSvc.transition("unblock", userId);
  }
}
