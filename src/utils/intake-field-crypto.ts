import crypto from "crypto";
import { INTAKE_FIELD_ENCRYPTION_ENABLED, INTAKE_FIELD_ENCRYPTION_KEY } from "../config";
import logger from "./logger";

/** Field-level encryption for IntakeMessage — the client/intake pipeline's own copy of
 * field-crypto.ts, not an import of it. The two are deliberately separate implementations of the
 * same method (AES-256-GCM, `enc1:<keyId>:<iv>:<tag>:<ciphertext>`, label bound into the AEAD
 * tag) with separate keys, per the 2026-10-28 intake-pipeline separation: nothing about intake
 * chat may share code, a table, or an encryption mechanism with the lawyer side, even a pure,
 * already-correct helper function. That has a real cost — a bugfix to one implementation does not
 * automatically reach the other, so a fix made here should be checked against field-crypto.ts
 * too, and vice versa — accepted deliberately, not an oversight.
 *
 * One key only, no rotation: INTAKE_FIELD_ENCRYPTION_KEY, a different value per environment (not
 * per region — there is no _UK/_PH split here). Off by default (INTAKE_FIELD_ENCRYPTION_ENABLED).
 * Reading never depends on the switch: a value that carries the prefix is opened whenever the
 * configured key matches, so turning the switch off never strands anything already sealed. */

export interface IntakeFieldCryptoConfig {
  enabled: boolean;
  key?: string;
}

const PREFIX = "enc1";

function fromEnv(): IntakeFieldCryptoConfig {
  return { enabled: INTAKE_FIELD_ENCRYPTION_ENABLED, key: INTAKE_FIELD_ENCRYPTION_KEY };
}

/** A 32-byte key given as 64 hex chars or base64; null for anything else. */
function parseKey(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const buf = /^[0-9a-f]{64}$/i.test(trimmed) ? Buffer.from(trimmed, "hex") : Buffer.from(trimmed, "base64");
  return buf.length === 32 ? buf : null;
}

function keyIdOf(key: Buffer): string {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 8);
}

function currentKey(cfg: IntakeFieldCryptoConfig): Buffer | null {
  return parseKey(cfg.key);
}

/** The id stamped into every value sealed with the current key, or null when no valid key is set. */
export function currentIntakeKeyId(cfg: IntakeFieldCryptoConfig = fromEnv()): string | null {
  const key = currentKey(cfg);
  return key ? keyIdOf(key) : null;
}

export function isIntakeEncryptedField(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(`${PREFIX}:`);
}

/** What the startup log says, so nobody has to guess whether intake sealing is on. */
export function intakeFieldEncryptionStatus(cfg: IntakeFieldCryptoConfig = fromEnv()): { enabled: boolean; keyConfigured: boolean } {
  return { enabled: cfg.enabled, keyConfigured: currentKey(cfg) !== null };
}

export function intakeFieldEncryptionEnabled(cfg: IntakeFieldCryptoConfig = fromEnv()): boolean {
  return cfg.enabled;
}

/** Seals `plain`. Throws when no valid key is configured. */
export function encryptIntakeField(plain: string, label: string, cfg: IntakeFieldCryptoConfig = fromEnv()): string {
  const key = currentKey(cfg);
  if (!key) throw new Error("INTAKE_FIELD_ENCRYPTION_KEY is not configured (32 bytes, base64 or 64 hex chars)");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(label, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [PREFIX, keyIdOf(key), iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(":");
}

/** The text inside a sealed value, or null when it cannot be opened (wrong/missing key, or the
 * value was sealed under a key that is no longer configured — there is no old-key fallback). A
 * value without the prefix is returned as it is. */
export function decryptIntakeField(stored: string, label: string, cfg: IntakeFieldCryptoConfig = fromEnv()): string | null {
  if (!isIntakeEncryptedField(stored)) return stored;
  const [, id, iv, tag, ciphertext] = stored.split(":");
  if (!id || !iv || !tag || !ciphertext) return null;
  const key = currentKey(cfg);
  if (!key || keyIdOf(key) !== id) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    decipher.setAAD(Buffer.from(label, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** What to store for `plain`: sealed when `protect` is true and the switch is on, otherwise as it
 * is. null and undefined pass through. */
export function sealIntakeField<T extends string | null | undefined>(plain: T, label: string, protect: boolean, cfg: IntakeFieldCryptoConfig = fromEnv()): T | string {
  if (typeof plain !== "string" || plain === "") return plain;
  return protect && cfg.enabled ? encryptIntakeField(plain, label, cfg) : plain;
}

/** What to show for a stored value: the opened text, the value itself when it was never sealed, or
 * null (logged) when it is sealed and cannot be opened. */
export function openIntakeField<T extends string | null | undefined>(stored: T, label: string, cfg: IntakeFieldCryptoConfig = fromEnv()): T | string | null {
  if (!isIntakeEncryptedField(stored)) return stored;
  const opened = decryptIntakeField(stored, label, cfg);
  if (opened === null) logger.warn("Intake field decryption failed: no matching key, wrong column or tampered value", { label });
  return opened;
}
