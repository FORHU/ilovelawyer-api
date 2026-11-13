import axios from "axios";
import { TURNSTILE_SECRET_KEY, isDev } from "../config";
import logger from "./logger";

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Checks a Cloudflare Turnstile token (the captcha on a signed-out Support Ticket). Fails closed:
 * a missing token, an unreachable Cloudflare or any error is a refusal. The one exception is
 * development with no TURNSTILE_SECRET_KEY set, which skips the check so the form works locally.
 */
export async function verifyTurnstile(token: string | undefined, ip?: string): Promise<boolean> {
  if (!TURNSTILE_SECRET_KEY) {
    if (isDev) return true;
    logger.error("Turnstile: TURNSTILE_SECRET_KEY is not set, refusing signed-out tickets");
    return false;
  }
  if (!token) return false;
  try {
    const form = new URLSearchParams({ secret: TURNSTILE_SECRET_KEY, response: token });
    if (ip) form.set("remoteip", ip);
    const { data } = await axios.post(VERIFY_URL, form, { timeout: 5000 });
    return data?.success === true;
  } catch (err) {
    logger.error("Turnstile: verification request failed", { err });
    return false;
  }
}
