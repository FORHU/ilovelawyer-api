import crypto from "crypto";

/**
 * Login handoff between the desktop app and a browser on the same PC.
 *
 * The two can't share a login — the desktop app's built-in browser keeps its own cookies — so a
 * client that is logged in asks for a one-time code (POST /api/auth/handoff) and passes it to the
 * other, which trades it for a login of its own (POST /api/auth/handoff/consume). The code:
 * - works once (consumed with an atomic GETDEL),
 * - expires after HANDOFF_TTL_SECONDS,
 * - is stored only as a SHA-256 hash, so reading Redis doesn't reveal a usable code,
 * - never logs anyone else out (unlike the approval email's login link).
 */
export function newHandoffCode(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** The Redis key a code is stored under — its hash, never the code itself. */
export function handoffKey(code: string): string {
  return `auth:handoff:${crypto.createHash("sha256").update(code).digest("hex")}`;
}
