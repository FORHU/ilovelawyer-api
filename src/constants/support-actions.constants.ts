export const SUPPORT_ACTION_KEYS = [
  "CHECK_PAYMENT",
  "SHOW_CREDITS",
  "SHOW_LAWYER_REQUESTS",
  "SEND_PASSWORD_RESET",
  "RESEND_CODE",
  "EXPORT_MY_DATA",
  "DELETE_MY_ACCOUNT",
  "OPEN_TICKET",
] as const;

export type SupportActionKey = (typeof SUPPORT_ACTION_KEYS)[number];

/** Who can run an action: signed-in clients, signed-out visitors, or both. */
export type SupportActionAudience = "IN" | "OUT" | "BOTH";

export type SupportAudience = "SIGNED_IN" | "SIGNED_OUT";

export interface SupportActionDef {
  key: SupportActionKey;
  label: string;
  audience: SupportActionAudience;
  /** Reads or changes the signed-in client's own account data. Never allowed signed out. */
  readsAccount: boolean;
  /** Fixed text the chat shows before running the action. Owned by the action, not editable. */
  safetyCopy?: string[];
}

export const DELETE_ACCOUNT_SAFETY_COPY = [
  "Your account will be deleted in 30 days. Signing in again before then cancels the deletion.",
  "Any unused Chat Credits are lost and are not refunded.",
  "If you have an open lawyer request, you need to withdraw it or end it first.",
];

/** The fixed Support Action catalog. Admins place an action in a flow by key; they can't change
 * what it does. Execution is in SupportActionSvc. */
export const SUPPORT_ACTIONS: Record<SupportActionKey, SupportActionDef> = {
  CHECK_PAYMENT: { key: "CHECK_PAYMENT", label: "Check a recent payment", audience: "IN", readsAccount: true },
  SHOW_CREDITS: { key: "SHOW_CREDITS", label: "Show my Chat Credits", audience: "IN", readsAccount: true },
  SHOW_LAWYER_REQUESTS: { key: "SHOW_LAWYER_REQUESTS", label: "Show my lawyer requests", audience: "IN", readsAccount: true },
  SEND_PASSWORD_RESET: { key: "SEND_PASSWORD_RESET", label: "Send a password reset email", audience: "BOTH", readsAccount: false },
  RESEND_CODE: { key: "RESEND_CODE", label: "Send my sign-in code again", audience: "OUT", readsAccount: false },
  EXPORT_MY_DATA: { key: "EXPORT_MY_DATA", label: "Export my data", audience: "IN", readsAccount: true },
  DELETE_MY_ACCOUNT: {
    key: "DELETE_MY_ACCOUNT",
    label: "Delete my account",
    audience: "IN",
    readsAccount: true,
    safetyCopy: DELETE_ACCOUNT_SAFETY_COPY,
  },
  OPEN_TICKET: { key: "OPEN_TICKET", label: "Talk to a person", audience: "BOTH", readsAccount: false },
};

export function isKnownActionKey(value: unknown): value is SupportActionKey {
  return typeof value === "string" && (SUPPORT_ACTION_KEYS as readonly string[]).includes(value);
}

export function actionAllowedFor(def: SupportActionDef, audience: SupportAudience): boolean {
  if (def.audience === "BOTH") return true;
  return audience === "SIGNED_IN" ? def.audience === "IN" : def.audience === "OUT";
}

export function actionsFor(audience: SupportAudience): SupportActionDef[] {
  return SUPPORT_ACTION_KEYS.map((k) => SUPPORT_ACTIONS[k]).filter((def) => actionAllowedFor(def, audience));
}

/** The whole catalog, in key order. */
export function listSupportActions(): SupportActionDef[] {
  return SUPPORT_ACTION_KEYS.map((key) => SUPPORT_ACTIONS[key]);
}
