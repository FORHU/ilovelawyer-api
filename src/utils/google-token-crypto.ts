import crypto from "crypto";
import { GOOGLE_TOKEN_ENC_KEY } from "../config";

const VERSION = "v1";

/** The 32-byte AES key from GOOGLE_TOKEN_ENC_KEY (base64, or 64 hex chars), or null when it's
 * unset or malformed — callers treat that as "Google Calendar can't be used here". */
function key(raw: string | undefined = GOOGLE_TOKEN_ENC_KEY): Buffer | null {
  if (!raw) return null;
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  return buf.length === 32 ? buf : null;
}

export function isGoogleTokenEncryptionConfigured(): boolean {
  return key() !== null;
}

/** AES-256-GCM, stored as `v1:<iv>:<tag>:<ciphertext>` (base64 parts) so the format can change
 * later without guessing. Throws when no key is configured — never stores a token in plain text. */
export function encryptGoogleToken(plain: string, rawKey?: string): string {
  const k = key(rawKey);
  if (!k) throw new Error("GOOGLE_TOKEN_ENC_KEY is not configured");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", k, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(":");
}

/** Null for anything that can't be decrypted — wrong or rotated key, tampering, unknown format.
 * Callers handle null like a revoked token: clear it and ask the user to reconnect. */
export function decryptGoogleToken(stored: string, rawKey?: string): string | null {
  const k = key(rawKey);
  if (!k) return null;
  const [version, iv, tag, ciphertext] = stored.split(":");
  if (version !== VERSION || !iv || !tag || !ciphertext) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
