import { ApprovalStatus } from "@prisma/client";

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
export interface TransitionSpec {
  from: ApprovalStatus;
  to: ApprovalStatus;
  template: string;
  subject: string;
}
