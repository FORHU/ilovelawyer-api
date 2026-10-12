/** Per-tenant keys (#343): the Singapore server holds PH, ph-dev and uk-dev data, so a tenant can have
 * its own key. New values are sealed with the owning tenant's key, and any configured key opens what
 * it sealed. Pure: the configuration is passed in. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it } from "mocha";
import { decryptField, encryptField, fieldEncryptionStatus, sealField, usesTenantKeys, type FieldCryptoConfig } from "../src/utils/field-crypto";

const phKey = crypto.randomBytes(32).toString("base64");
const ukKey = crypto.randomBytes(32).toString("hex");
const LABEL = "CaseDocumentChunk.chunkText";
const keyId = (sealed: string) => sealed.split(":")[1];

/** What the Singapore server runs with: the PH key as the default and a separate one for UK. */
const singapore: FieldCryptoConfig = { enabled: true, key: phKey, tenantKeys: { PH: undefined, UK: ukKey } };

describe("field-crypto per-tenant keys", () => {
  it("seals with the tenant's own key, and with the default for a tenant that has none", () => {
    const uk = encryptField("uk text", LABEL, singapore, "UK");
    const ph = encryptField("ph text", LABEL, singapore, "PH");
    const none = encryptField("no tenant", LABEL, singapore);
    expect(keyId(uk)).to.not.equal(keyId(ph));
    expect(keyId(ph)).to.equal(keyId(none)); // PH has no key of its own, so it uses the default
    expect(keyId(none)).to.equal(keyId(encryptField("x", LABEL, { enabled: true, key: phKey })));
  });

  it("opens each value with the configuration that holds the key, whichever tenant it belongs to", () => {
    const uk = encryptField("uk text", LABEL, singapore, "UK");
    const ph = encryptField("ph text", LABEL, singapore, "PH");
    expect(decryptField(uk, LABEL, singapore)).to.equal("uk text");
    expect(decryptField(ph, LABEL, singapore)).to.equal("ph text");
  });

  it("keeps the two tenants apart: a server with only the PH key cannot open UK text", () => {
    const uk = encryptField("uk text", LABEL, singapore, "UK");
    const phOnly: FieldCryptoConfig = { enabled: true, key: phKey };
    expect(decryptField(uk, LABEL, phOnly)).to.equal(null);
    expect(decryptField(encryptField("ph text", LABEL, singapore, "PH"), LABEL, phOnly)).to.equal("ph text");
  });

  it("never falls back to the default key when a tenant key is set but not valid", () => {
    const broken: FieldCryptoConfig = { enabled: true, key: phKey, tenantKeys: { UK: "not-a-key" } };
    expect(() => encryptField("uk text", LABEL, broken, "UK")).to.throw(/FIELD_ENCRYPTION_KEY_UK/);
    expect(keyId(encryptField("ph text", LABEL, broken, "PH"))).to.be.a("string"); // other tenants are unaffected
  });

  it("an empty or spaces-only tenant key counts as not set", () => {
    const cfg: FieldCryptoConfig = { enabled: true, key: phKey, tenantKeys: { UK: "   " } };
    expect(keyId(encryptField("x", LABEL, cfg, "UK"))).to.equal(keyId(encryptField("x", LABEL, { enabled: true, key: phKey })));
    expect(usesTenantKeys(cfg)).to.equal(false);
  });

  it("without any default key a tenant with its own key can still seal, and a tenant without one cannot", () => {
    const ukOnly: FieldCryptoConfig = { enabled: true, tenantKeys: { UK: ukKey } };
    expect(decryptField(encryptField("uk text", LABEL, ukOnly, "UK"), LABEL, ukOnly)).to.equal("uk text");
    expect(() => encryptField("ph text", LABEL, ukOnly, "PH")).to.throw(/FIELD_ENCRYPTION_KEY is not configured/);
  });

  it("sealField passes the tenant through, and still does nothing when the switch is off", () => {
    const sealed = sealField("uk text", LABEL, true, singapore, "UK");
    expect(keyId(sealed)).to.equal(keyId(encryptField("x", LABEL, singapore, "UK")));
    expect(sealField("uk text", LABEL, true, { ...singapore, enabled: false }, "UK")).to.equal("uk text");
  });

  it("earlier keys still open old values next to the tenant keys", () => {
    const old = crypto.randomBytes(32).toString("base64");
    const oldValue = encryptField("old text", LABEL, { enabled: true, key: old });
    expect(decryptField(oldValue, LABEL, { ...singapore, oldKeys: old })).to.equal("old text");
    expect(decryptField(oldValue, LABEL, singapore)).to.equal(null);
  });

  describe("usesTenantKeys", () => {
    it("is false for a server with one key, so no tenant lookup is made", () => {
      expect(usesTenantKeys({ enabled: true, key: phKey })).to.equal(false);
      expect(usesTenantKeys({ enabled: true, key: phKey, tenantKeys: {} })).to.equal(false);
      expect(usesTenantKeys({ enabled: true, key: phKey, tenantKeys: { UK: undefined, PH: "" } })).to.equal(false);
    });
    it("is true when a tenant has its own key, and false while the switch is off", () => {
      expect(usesTenantKeys(singapore)).to.equal(true);
      expect(usesTenantKeys({ ...singapore, enabled: false })).to.equal(false);
    });
  });

  describe("fieldEncryptionStatus (the startup line)", () => {
    it("reports the default key and which tenants have their own", () => {
      expect(fieldEncryptionStatus(singapore)).to.deep.include({ enabled: true, keyConfigured: true, tenantKeys: ["UK"], invalidTenantKeys: [] });
    });
    it("reports a tenant key that is not valid", () => {
      expect(fieldEncryptionStatus({ enabled: true, key: phKey, tenantKeys: { UK: "nope" } })).to.deep.include({ keyConfigured: true, tenantKeys: [], invalidTenantKeys: ["UK"] });
    });
    it("reports a missing default key", () => {
      expect(fieldEncryptionStatus({ enabled: true, tenantKeys: { UK: ukKey } })).to.deep.include({ keyConfigured: false, tenantKeys: ["UK"] });
    });
    it("a server with one key reports no tenant keys", () => {
      expect(fieldEncryptionStatus({ enabled: true, key: phKey })).to.deep.include({ keyConfigured: true, tenantKeys: [], invalidTenantKeys: [] });
    });
  });
});
