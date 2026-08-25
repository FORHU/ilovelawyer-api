import { ApprovalStatus } from "@prisma/client";
import AuthRepo from "../repositories/auth.repository";
import HttpError from "../utils/http-error";
import { sendEmail } from "../utils/mailer";
import { renderTemplate } from "../utils/template";

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
  static async listUsers() {
    return AuthRepo.listAllUsers();
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
