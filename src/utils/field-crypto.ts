import crypto from "crypto";
import { FIELD_ENCRYPTION_ENABLED, FIELD_ENCRYPTION_KEY, FIELD_ENCRYPTION_OLD_KEYS, FIELD_ENCRYPTION_TENANT_KEYS } from "../config";
import logger from "./logger";

/** Field-level encryption for privileged text stored in ordinary columns (issue #343).
 *
 * AES-256-GCM, stored as `enc1:<keyId>:<iv>:<tag>:<ciphertext>` (base64 parts). `keyId` names the
 * key that sealed it (the first 8 hex of its SHA-256), so a value can still be read after the key
 * is rotated: put the new key in FIELD_ENCRYPTION_KEY and keep the old one in
 * FIELD_ENCRYPTION_OLD_KEYS (comma-separated) until every value has been re-sealed. The `label`
 * (for example "EvidenceMatrixItem.notes") is bound into the tag, so a ciphertext copied into a
 * different column does not open.
 *
 * Off by default (FIELD_ENCRYPTION_ENABLED). Reading never depends on the switch: a value that
 * carries the prefix is opened whenever a matching key is configured, so turning the switch off
 * does not strand anything that was already sealed. */

export interface FieldCryptoConfig {
  enabled: boolean;
  key?: string;
  oldKeys?: string;
  /** Keys for tenants that have their own, by tenant code ("PH", "UK"). */
  tenantKeys?: Record<string, string | undefined>;
}

const PREFIX = "enc1";

function fromEnv(): FieldCryptoConfig {
  return { enabled: FIELD_ENCRYPTION_ENABLED, key: FIELD_ENCRYPTION_KEY, oldKeys: FIELD_ENCRYPTION_OLD_KEYS, tenantKeys: FIELD_ENCRYPTION_TENANT_KEYS };
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

const tenantKeySetting = (cfg: FieldCryptoConfig, tenant?: string): string | undefined => {
  const raw = tenant ? cfg.tenantKeys?.[tenant] : undefined;
  return raw && raw.trim() ? raw : undefined;
};

/** The key new values are sealed with: the tenant's own key when it has one, otherwise the default.
 * A tenant key that is set but not a valid key gives null, never a quiet fall back to the default. */
function currentKey(cfg: FieldCryptoConfig, tenant?: string): Buffer | null {
  const own = tenantKeySetting(cfg, tenant);
  return parseKey(own ?? cfg.key);
}

// Opening a document means opening thousands of chunks, so the parsed keys are kept until the
// configuration changes instead of being parsed and hashed for every value.
let keyCache: { signature: string; keys: Map<string, Buffer> } | null = null;

function keysById(cfg: FieldCryptoConfig): Map<string, Buffer> {
  const tenantKeys = Object.entries(cfg.tenantKeys ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v ?? "");
  const signature = `${cfg.key ?? ""}|${cfg.oldKeys ?? ""}|${tenantKeys.join(",")}`;
  if (keyCache?.signature === signature) return keyCache.keys;
  // Every configured key can open what it sealed: the default, each tenant's, and earlier ones.
  const all = [cfg.key, ...tenantKeys, ...(cfg.oldKeys ?? "").split(",")].map(parseKey).filter((k): k is Buffer => k !== null);
  const keys = new Map(all.map((k) => [keyIdOf(k), k]));
  keyCache = { signature, keys };
  return keys;
}

export function isEncryptedField(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(`${PREFIX}:`);
}

/** True when some tenant has its own key, so the tenant that owns a value has to be looked up before
 * sealing it. False (and no lookup is made) everywhere that uses one key, which is every server today
 * except the Singapore one. */
export function usesTenantKeys(cfg: FieldCryptoConfig = fromEnv()): boolean {
  return cfg.enabled && Object.keys(cfg.tenantKeys ?? {}).some((tenant) => tenantKeySetting(cfg, tenant) !== undefined);
}

/** What the startup log says, so nobody has to guess whether sealing is on: the switch, whether a
 * usable key is set, which tenants have their own key (and which of those are not valid), and how
 * many earlier keys are still accepted for reading. */
export function fieldEncryptionStatus(cfg: FieldCryptoConfig = fromEnv()): {
  enabled: boolean;
  keyConfigured: boolean;
  tenantKeys: string[];
  invalidTenantKeys: string[];
  previousKeys: number;
} {
  const current = currentKey(cfg);
  const previous = [...keysById(cfg).values()].filter((k) => !current || !k.equals(current)).length;
  const withOwnKey = Object.keys(cfg.tenantKeys ?? {}).filter((tenant) => tenantKeySetting(cfg, tenant) !== undefined).sort();
  const invalid = withOwnKey.filter((tenant) => currentKey(cfg, tenant) === null);
  return {
    enabled: cfg.enabled,
    keyConfigured: current !== null,
    tenantKeys: withOwnKey.filter((tenant) => !invalid.includes(tenant)),
    invalidTenantKeys: invalid,
    previousKeys: Math.max(0, previous - withOwnKey.length + invalid.length),
  };
}

/** True when new privileged values should be written sealed. */
export function fieldEncryptionEnabled(cfg: FieldCryptoConfig = fromEnv()): boolean {
  return cfg.enabled;
}

/** Seals `plain`. Throws when no valid key is configured: it never falls back to storing the text
 * as it is when the caller asked for it to be protected. */
export function encryptField(plain: string, label: string, cfg: FieldCryptoConfig = fromEnv(), tenant?: string): string {
  const key = currentKey(cfg, tenant);
  if (!key) {
    const setting = tenantKeySetting(cfg, tenant) !== undefined ? `FIELD_ENCRYPTION_KEY_${tenant}` : "FIELD_ENCRYPTION_KEY";
    throw new Error(`${setting} is not configured (32 bytes, base64 or 64 hex chars)`);
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(label, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [PREFIX, keyIdOf(key), iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(":");
}

/** The text inside a sealed value, or null when it cannot be opened: no key with that id, a wrong
 * label, tampering, or an unknown format. A value without the prefix is returned as it is. */
export function decryptField(stored: string, label: string, cfg: FieldCryptoConfig = fromEnv()): string | null {
  if (!isEncryptedField(stored)) return stored;
  const [, id, iv, tag, ciphertext] = stored.split(":");
  if (!id || !iv || !tag || !ciphertext) return null;
  const key = keysById(cfg).get(id);
  if (!key) return null;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    decipher.setAAD(Buffer.from(label, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** What to store for `plain`: sealed when `protect` is true and the switch is on, otherwise as it is.
 * null and undefined pass through. `tenant` picks the tenant's own key when it has one. */
export function sealField<T extends string | null | undefined>(plain: T, label: string, protect: boolean, cfg: FieldCryptoConfig = fromEnv(), tenant?: string): T | string {
  if (typeof plain !== "string" || plain === "") return plain;
  return protect && cfg.enabled ? encryptField(plain, label, cfg, tenant) : plain;
}

/** What to show for a stored value: the opened text, the value itself when it was never sealed, or
 * null (logged) when it is sealed and cannot be opened. */
export function openField<T extends string | null | undefined>(stored: T, label: string, cfg: FieldCryptoConfig = fromEnv()): T | string | null {
  if (!isEncryptedField(stored)) return stored;
  const opened = decryptField(stored, label, cfg);
  if (opened === null) logger.warn("Field decryption failed: no matching key, wrong column or tampered value", { label });
  return opened;
}

/** `row` with every sealed string opened, for output that reads a table without going through its
 * repository (the data export). Labels are `<Model>.<field>`. */
export function openRow<T extends Record<string, unknown>>(model: string, row: T, cfg: FieldCryptoConfig = fromEnv()): T {
  let out: Record<string, unknown> | null = null;
  for (const [field, value] of Object.entries(row)) {
    if (!isEncryptedField(value)) continue;
    out ??= { ...row };
    out[field] = openField(value, `${model}.${field}`, cfg);
  }
  return (out ?? row) as T;
}
