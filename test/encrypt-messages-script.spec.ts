/** The message backfill script (#278): seals the text of messages stored before field encryption was
 * turned on (and can put it back, or move it to the current key), exactly as the document chunk
 * script does for chunks. What is checked are its safety rules: a dry run changes nothing, a run can
 * be repeated, it can be limited to one consultation, a message that cannot be opened is left exactly
 * as it is, and a row that changed since it was read is never overwritten.
 *
 * No live Postgres: the message delegate is monkeypatched on the shared client with a small in-memory
 * store that understands just the filters the script uses, same idiom as test/message-encryption.spec.ts.
 * The real SQL behaviour is checked separately against a local database. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import prisma from "../src/lib/prisma";
import * as config from "../src/config";
import { encryptField } from "../src/utils/field-crypto";
import { openMessage } from "../src/utils/message-content";
import { backfillMessages } from "../src/scripts/encrypt-messages";

type Row = { id: string; consultationId: string; role: string; content: string; pendingReplyContent: string | null; [key: string]: unknown };

const KEY = crypto.randomBytes(32).toString("base64");
const quiet = () => {};

describe("message backfill script", () => {
  const cfg = config as unknown as Record<string, unknown>;
  const saved = { enabled: cfg.FIELD_ENCRYPTION_ENABLED, key: cfg.FIELD_ENCRYPTION_KEY, oldKeys: cfg.FIELD_ENCRYPTION_OLD_KEYS };
  const original = { message: { ...prisma.message } };
  let rows: Row[];

  const set = (enabled: boolean, key: string | undefined, oldKeys?: string) => {
    cfg.FIELD_ENCRYPTION_ENABLED = enabled;
    cfg.FIELD_ENCRYPTION_KEY = key;
    cfg.FIELD_ENCRYPTION_OLD_KEYS = oldKeys;
  };
  const add = (fields: Partial<Row> & { content: string }): Row => {
    const row: Row = { id: `m${String(rows.length + 1).padStart(3, "0")}`, consultationId: "c1", role: "user", pendingReplyContent: null, ...fields };
    rows.push(row);
    return row;
  };
  const stored = () => rows.map((r) => ({ content: r.content, pending: r.pendingReplyContent }));
  const isSealed = (v: string | null) => typeof v === "string" && v.startsWith("enc1:");

  /** Just the filters the script uses: field equality (null included), { gt }, { not }, { startsWith },
   * NOT, and OR; the keys of one object must all hold. */
  const matches = (row: Row, where: any = {}): boolean =>
    Object.entries(where).every(([k, v]: [string, any]) => {
      if (k === "OR") return v.some((w: any) => matches(row, w));
      if (k === "AND") return v.every((w: any) => matches(row, w));
      if (k === "NOT") return !matches(row, v);
      if (v !== null && typeof v === "object") {
        const val = row[k];
        if ("gt" in v && !(typeof val === "string" && val > v.gt)) return false;
        if ("not" in v && (val === null || val === v.not)) return false;
        if ("startsWith" in v && !(typeof val === "string" && val.startsWith(v.startsWith))) return false;
        return true;
      }
      return row[k] === v;
    });

  beforeEach(() => {
    rows = [];
    set(true, KEY);
    Object.assign(prisma.message, {
      findMany: async ({ where, orderBy, take }: any) => {
        const found = rows.filter((r) => matches(r, where));
        if (orderBy?.id === "asc") found.sort((a, b) => (a.id < b.id ? -1 : 1));
        return found.slice(0, take ?? found.length).map((r) => ({ ...r }));
      },
      updateMany: async ({ where, data }: any) => {
        const hit = rows.filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      },
    });
  });

  afterEach(() => {
    set(saved.enabled as boolean, saved.key as string | undefined, saved.oldKeys as string | undefined);
    Object.assign(prisma.message, original.message);
  });

  describe("sealing", () => {
    it("a dry run reports what it would seal and changes nothing", async () => {
      add({ content: "My landlord kept my deposit", pendingReplyContent: "Under the Rental Act" });
      add({ content: "Second question" });
      const before = stored();
      const result = await backfillMessages({ apply: false }, quiet);
      expect(result).to.deep.equal({ matched: 2, changed: 0, unreadable: 0 });
      expect(stored()).to.deep.equal(before);
    });

    it("seals content and the partial reply, and every message still reads back as it was written", async () => {
      add({ content: "My landlord kept my deposit", pendingReplyContent: "Under the Rental Act" });
      add({ content: "Second question" });
      const result = await backfillMessages({ apply: true }, quiet);
      expect(result).to.deep.equal({ matched: 2, changed: 2, unreadable: 0 });
      expect(isSealed(rows[0].content)).to.equal(true);
      expect(isSealed(rows[0].pendingReplyContent)).to.equal(true);
      expect(isSealed(rows[1].content)).to.equal(true);
      expect(rows[1].pendingReplyContent).to.equal(null);
      expect(rows[0].content).to.not.include("landlord");
      expect(rows.map((r) => openMessage(r)?.content)).to.deep.equal(["My landlord kept my deposit", "Second question"]);
      expect(openMessage(rows[0])?.pendingReplyContent).to.equal("Under the Rental Act");
    });

    it("can be run again and does nothing the second time", async () => {
      add({ content: "My landlord kept my deposit", pendingReplyContent: "Under the Rental Act" });
      await backfillMessages({ apply: true }, quiet);
      const afterFirst = stored();
      expect(await backfillMessages({ apply: true }, quiet)).to.deep.equal({ matched: 0, changed: 0, unreadable: 0 });
      expect(stored()).to.deep.equal(afterFirst);
    });

    it("leaves a message that is already sealed alone, and seals only the field that is not", async () => {
      const sealed = encryptField("already sealed", "Message.content", { enabled: true, key: KEY });
      add({ content: sealed, pendingReplyContent: "still plain" });
      const result = await backfillMessages({ apply: true }, quiet);
      expect(result).to.deep.equal({ matched: 1, changed: 1, unreadable: 0 });
      expect(rows[0].content).to.equal(sealed);
      expect(isSealed(rows[0].pendingReplyContent)).to.equal(true);
    });

    it("skips empty text, so blank file-only messages stay blank and a rerun still finds nothing", async () => {
      add({ content: "", pendingReplyContent: "" });
      expect(await backfillMessages({ apply: true }, quiet)).to.deep.equal({ matched: 0, changed: 0, unreadable: 0 });
      expect(stored()).to.deep.equal([{ content: "", pending: "" }]);
    });

    it("seals only the consultation it is limited to", async () => {
      add({ content: "in the chosen consultation", consultationId: "c1" });
      add({ content: "in another consultation", consultationId: "c2" });
      const result = await backfillMessages({ apply: true, consultationId: "c1" }, quiet);
      expect(result).to.deep.equal({ matched: 1, changed: 1, unreadable: 0 });
      expect(isSealed(rows[0].content)).to.equal(true);
      expect(rows[1].content).to.equal("in another consultation");
    });

    it("works through more messages than one batch holds", async () => {
      for (let i = 0; i < 450; i += 1) add({ content: `message ${i}` });
      const result = await backfillMessages({ apply: true }, quiet);
      expect(result).to.deep.equal({ matched: 450, changed: 450, unreadable: 0 });
      expect(rows.every((r) => isSealed(r.content))).to.equal(true);
    });

    it("never overwrites a message that was edited after the script read it", async () => {
      add({ content: "as the script read it" });
      const realFindMany = (prisma.message as any).findMany;
      (prisma.message as any).findMany = async (args: any) => {
        const found = await realFindMany(args);
        rows[0].content = "edited while the script ran";
        return found;
      };
      const result = await backfillMessages({ apply: true }, quiet);
      expect(result.changed).to.equal(0);
      expect(rows[0].content).to.equal("edited while the script ran");
    });
  });

  describe("settings", () => {
    it("refuses to seal, changing nothing, when the switch is off", async () => {
      add({ content: "plain" });
      set(false, KEY);
      let message = "";
      await backfillMessages({ apply: true }, quiet).catch((e) => (message = e.message));
      expect(message).to.include("FIELD_ENCRYPTION_ENABLED");
      expect(rows[0].content).to.equal("plain");
    });

    it("refuses to seal, changing nothing, when there is no key", async () => {
      add({ content: "plain" });
      set(true, undefined);
      let message = "";
      await backfillMessages({ apply: true }, quiet).catch((e) => (message = e.message));
      expect(message).to.include("FIELD_ENCRYPTION_KEY");
      expect(rows[0].content).to.equal("plain");
    });
  });

  describe("--reverse", () => {
    it("puts sealed text back to plain, in both fields, and reads the same afterwards", async () => {
      add({ content: "first", pendingReplyContent: "partial" });
      add({ content: "second" });
      await backfillMessages({ apply: true }, quiet);
      const result = await backfillMessages({ apply: true, reverse: true }, quiet);
      expect(result).to.deep.equal({ matched: 2, changed: 2, unreadable: 0 });
      expect(stored()).to.deep.equal([{ content: "first", pending: "partial" }, { content: "second", pending: null }]);
    });

    it("a dry run changes nothing, and a rerun after the undo finds nothing", async () => {
      add({ content: "first" });
      await backfillMessages({ apply: true }, quiet);
      const sealed = stored();
      expect(await backfillMessages({ apply: false, reverse: true }, quiet)).to.deep.equal({ matched: 1, changed: 0, unreadable: 0 });
      expect(stored()).to.deep.equal(sealed);
      await backfillMessages({ apply: true, reverse: true }, quiet);
      expect(await backfillMessages({ apply: true, reverse: true }, quiet)).to.deep.equal({ matched: 0, changed: 0, unreadable: 0 });
    });

    it("counts a message it cannot open and leaves it exactly as it is, even next to one it can", async () => {
      const strangers = encryptField("sealed with a key nobody here has", "Message.content", { enabled: true, key: crypto.randomBytes(32).toString("base64") });
      add({ content: "mine" });
      await backfillMessages({ apply: true }, quiet);
      add({ content: strangers });
      const result = await backfillMessages({ apply: true, reverse: true }, quiet);
      expect(result).to.deep.equal({ matched: 1, changed: 1, unreadable: 1 });
      expect(rows[0].content).to.equal("mine");
      expect(rows[1].content).to.equal(strangers);
    });

    it("needs the key to open what is sealed, but not the switch", async () => {
      add({ content: "mine" });
      await backfillMessages({ apply: true }, quiet);
      set(false, KEY);
      expect((await backfillMessages({ apply: true, reverse: true }, quiet)).changed).to.equal(1);
      set(false, undefined);
      add({ content: encryptField("x", "Message.content", { enabled: true, key: KEY }) });
      let message = "";
      await backfillMessages({ apply: true, reverse: true }, quiet).catch((e) => (message = e.message));
      expect(message).to.include("FIELD_ENCRYPTION_KEY");
    });
  });

  describe("--rekey", () => {
    const OLD_KEY = crypto.randomBytes(32).toString("base64");
    const sealedUnder = (key: string, plain: string, label = "Message.content") => encryptField(plain, label, { enabled: true, key });

    it("re-seals messages sealed under an earlier key with the current key, so one key is enough afterwards", async () => {
      add({ content: sealedUnder(OLD_KEY, "old one"), pendingReplyContent: sealedUnder(OLD_KEY, "old partial", "Message.pendingReplyContent") });
      add({ content: sealedUnder(KEY, "already current") });
      set(true, KEY, OLD_KEY);
      const result = await backfillMessages({ apply: true, rekey: true }, quiet);
      expect(result).to.deep.equal({ matched: 1, changed: 1, unreadable: 0 });
      set(true, KEY, undefined);
      expect(openMessage(rows[0])).to.include({ content: "old one", pendingReplyContent: "old partial" });
      expect(openMessage(rows[1])?.content).to.equal("already current");
    });

    it("counts a message whose earlier key is not listed and leaves it exactly as it is", async () => {
      const lost = sealedUnder(crypto.randomBytes(32).toString("base64"), "key is gone");
      add({ content: lost });
      const result = await backfillMessages({ apply: true, rekey: true }, quiet);
      expect(result).to.deep.equal({ matched: 0, changed: 0, unreadable: 1 });
      expect(rows[0].content).to.equal(lost);
    });

    it("does not combine with --reverse, and changes nothing", async () => {
      add({ content: "plain" });
      let message = "";
      await backfillMessages({ apply: true, rekey: true, reverse: true }, quiet).catch((e) => (message = e.message));
      expect(message).to.include("--reverse");
      expect(rows[0].content).to.equal("plain");
    });
  });
});
