import { TransitionSpec } from "../types/admin.types";

export const USERS_LIST_CACHE_TTL_S = 60;
export const USERS_LIST_VERSION_KEY = "admin:users:version";

export const TRANSITIONS: Record<string, TransitionSpec> = {
  approve: { from: "PENDING", to: "ACTIVE", template: "signup-approved", subject: "Your ilovelawyer account has been approved" },
  deny: { from: "PENDING", to: "DENIED", template: "signup-denied", subject: "Your ilovelawyer signup" },
  reactivate: { from: "DENIED", to: "ACTIVE", template: "signup-reactivated", subject: "Your ilovelawyer account has been reactivated" },
  block: { from: "ACTIVE", to: "BLOCKED", template: "account-blocked", subject: "Your ilovelawyer account has been blocked" },
  unblock: { from: "BLOCKED", to: "ACTIVE", template: "account-unblocked", subject: "Your ilovelawyer account has been unblocked" },
};
