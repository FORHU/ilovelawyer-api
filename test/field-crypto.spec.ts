/** Field-level encryption helper (#343): what it seals, what it refuses to open, and how rotation
 * works. Pure: the configuration is passed in, nothing touches a database. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it } from "mocha";
import {
  decryptField,
  encryptField,
  fieldEncryptionEnabled,
  isEncryptedField,
  openField,
  openRow,
  sealField,
  type FieldCryptoConfig,
} from "../src/utils/field-crypto";

const keyA = crypto.randomBytes(32).toString("base64");
const keyB = crypto.randomBytes(32).toString("hex");
const on: FieldCryptoConfig = { enabled: true, key: keyA };
const LABEL = "EvidenceMatrixItem.notes";

describe("field-crypto", () => {
  it("round-trips text and stores nothing readable", () => {
    const sealed = encryptField("Client admitted the transfer on 3 May", LABEL, on);
    expect(isEncryptedField(sealed)).to.equal(true);
    expect(sealed).to.not.include("Client");
    expect(sealed).to.not.include("transfer");
    expect(decryptField(sealed, LABEL, on)).to.equal("Client admitted the transfer on 3 May");
  });

  it("uses a fresh nonce each time", () => {
    expect(encryptField("same", LABEL, on)).to.not.equal(encryptField("same", LABEL, on));
  });

  it("handles unicode and long text", () => {
    const text = "Réponse: 你好 ".repeat(500);
    expect(decryptField(encryptField(text, LABEL, on), LABEL, on)).to.equal(text);
  });

  it("will not open a value moved into a different column", () => {
    const sealed = encryptField("secret", LABEL, on);
    expect(decryptField(sealed, "EvidenceCustodyEvent.notes", on)).to.equal(null);
  });

  it("will not open a tampered value", () => {
    const parts = encryptField("secret", LABEL, on).split(":");
    parts[4] = Buffer.from("tampered-bytes").toString("base64");
    expect(decryptField(parts.join(":"), LABEL, on)).to.equal(null);
  });

  it("returns null for a malformed sealed value instead of throwing", () => {
    expect(decryptField("enc1:onlytwo:parts", LABEL, on)).to.equal(null);
  });

  it("returns a value that was never sealed as it is", () => {
    expect(decryptField("plain note", LABEL, on)).to.equal("plain note");
  });

  it("opens nothing without the key that sealed it", () => {
    const sealed = encryptField("secret", LABEL, on);
    expect(decryptField(sealed, LABEL, { enabled: true, key: keyB })).to.equal(null);
    expect(decryptField(sealed, LABEL, { enabled: true })).to.equal(null);
  });

  describe("rotation", () => {
    it("keeps reading old values once the old key is listed, and writes with the new key", () => {
      const oldSealed = encryptField("old note", LABEL, on);
      const rotated: FieldCryptoConfig = { enabled: true, key: keyB, oldKeys: keyA };
      expect(decryptField(oldSealed, LABEL, rotated)).to.equal("old note");

      const newSealed = encryptField("new note", LABEL, rotated);
      expect(newSealed.split(":")[1]).to.not.equal(oldSealed.split(":")[1]);
      expect(decryptField(newSealed, LABEL, rotated)).to.equal("new note");
    });

    it("cannot read old values once the old key is dropped", () => {
      const oldSealed = encryptField("old note", LABEL, on);
      expect(decryptField(oldSealed, LABEL, { enabled: true, key: keyB })).to.equal(null);
    });

    it("accepts several old keys and ignores a malformed one", () => {
      const sealedWithA = encryptField("a", LABEL, on);
      const sealedWithB = encryptField("b", LABEL, { enabled: true, key: keyB });
      const cfg: FieldCryptoConfig = { enabled: true, key: crypto.randomBytes(32).toString("base64"), oldKeys: `not-a-key, ${keyA} ,${keyB}` };
      expect(decryptField(sealedWithA, LABEL, cfg)).to.equal("a");
      expect(decryptField(sealedWithB, LABEL, cfg)).to.equal("b");
    });
  });

  describe("without a usable key", () => {
    it("refuses to seal rather than store the text as it is", () => {
      expect(() => encryptField("secret", LABEL, { enabled: true })).to.throw(/FIELD_ENCRYPTION_KEY/);
      expect(() => encryptField("secret", LABEL, { enabled: true, key: "too-short" })).to.throw(/FIELD_ENCRYPTION_KEY/);
    });

    it("sealField throws when it is asked to protect and encryption is on but the key is missing", () => {
      expect(() => sealField("secret", LABEL, true, { enabled: true })).to.throw(/FIELD_ENCRYPTION_KEY/);
    });
  });

  describe("sealField", () => {
    it("seals only when asked to protect and the switch is on", () => {
      expect(isEncryptedField(sealField("note", LABEL, true, on))).to.equal(true);
      expect(sealField("note", LABEL, false, on)).to.equal("note");
      expect(sealField("note", LABEL, true, { enabled: false, key: keyA })).to.equal("note");
    });

    it("passes null, undefined and empty text through", () => {
      expect(sealField(null, LABEL, true, on)).to.equal(null);
      expect(sealField(undefined, LABEL, true, on)).to.equal(undefined);
      expect(sealField("", LABEL, true, on)).to.equal("");
    });
  });

  describe("openField", () => {
    it("opens sealed text, passes plain text and nulls through, and reports false for the switch", () => {
      expect(openField(encryptField("x", LABEL, on), LABEL, on)).to.equal("x");
      expect(openField("plain", LABEL, on)).to.equal("plain");
      expect(openField(null, LABEL, on)).to.equal(null);
      expect(fieldEncryptionEnabled({ enabled: false })).to.equal(false);
    });

    it("opens whether or not the switch is on", () => {
      const sealed = encryptField("x", LABEL, on);
      expect(openField(sealed, LABEL, { enabled: false, key: keyA })).to.equal("x");
    });

    it("returns null for a sealed value it cannot open", () => {
      expect(openField(encryptField("x", LABEL, on), LABEL, { enabled: true, key: keyB })).to.equal(null);
    });
  });

  describe("openRow", () => {
    it("opens sealed columns using the model and field name, and leaves the rest alone", () => {
      const row = { id: "1", notes: encryptField("n", "EvidenceMatrixItem.notes", on), action: "received" };
      const opened = openRow("EvidenceMatrixItem", row, on);
      expect(opened).to.deep.equal({ id: "1", notes: "n", action: "received" });
      expect(row.notes.startsWith("enc1:")).to.equal(true);
    });

    it("returns the same object when nothing is sealed", () => {
      const row = { id: "1", notes: "plain" };
      expect(openRow("EvidenceMatrixItem", row, on)).to.equal(row);
    });
  });
});
