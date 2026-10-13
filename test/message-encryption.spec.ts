/** Chat message text is stored sealed (#277): Message.content and Message.pendingReplyContent, with
 * the same field-crypto helper and key as notes and document chunks. Callers always see plain text,
 * and a sealed message that cannot be opened is left out instead of failing the chat.
 *
 * No live Postgres: the message delegate is monkeypatched on the shared client with a small
 * in-memory store, same idiom as test/evidence-notes-encryption.spec.ts. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import prisma from "../src/lib/prisma";
import * as config from "../src/config";
import ChatRepo from "../src/repositories/chat.repository";
import TraceRepo from "../src/repositories/trace.repository";
import { encryptField } from "../src/utils/field-crypto";

type Row = {
  id: string;
  consultationId: string;
  role: string;
  content: string;
  pendingReplyContent: string | null;
  parentMessageId: string | null;
  createdAt: Date;
  [key: string]: unknown;
};

const KEY = crypto.randomBytes(32).toString("base64");
const OTHER_KEY = crypto.randomBytes(32).toString("base64");
const SECRET = "My landlord kept my deposit after I moved out";

describe("message encryption", () => {
  const cfg = config as unknown as Record<string, unknown>;
  const original = {
    enabled: cfg.FIELD_ENCRYPTION_ENABLED,
    key: cfg.FIELD_ENCRYPTION_KEY,
    oldKeys: cfg.FIELD_ENCRYPTION_OLD_KEYS,
    message: { ...prisma.message },
    caseUpdateMany: prisma.case.updateMany,
  };
  let rows: Row[];
  let seq: number;

  beforeEach(() => {
    cfg.FIELD_ENCRYPTION_ENABLED = true;
    cfg.FIELD_ENCRYPTION_KEY = KEY;
    cfg.FIELD_ENCRYPTION_OLD_KEYS = undefined;
    rows = [];
    seq = 0;
    (prisma.case as any).updateMany = async () => ({ count: 0 });
    Object.assign(prisma.message, {
      create: async ({ data }: any) => {
        const row = { id: `m${++seq}`, pendingReplyContent: null, parentMessageId: null, createdAt: new Date(), ...data } as Row;
        rows.push(row);
        return { ...row };
      },
      update: async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return { ...row };
      },
    });
  });

  afterEach(() => {
    cfg.FIELD_ENCRYPTION_ENABLED = original.enabled;
    cfg.FIELD_ENCRYPTION_KEY = original.key;
    cfg.FIELD_ENCRYPTION_OLD_KEYS = original.oldKeys;
    Object.assign(prisma.message, original.message);
    (prisma.case as any).updateMany = original.caseUpdateMany;
  });

  /** A message sealed with `key`: the current one, or another key nobody here holds. */
  const sealedWith = (key: string, plain: string, label = "Message.content") => encryptField(plain, label, { enabled: true, key });
  const seed = (fields: Partial<Row> & { content: string }): Row => {
    const row = { id: `m${++seq}`, consultationId: "c1", role: "user", pendingReplyContent: null, parentMessageId: null, createdAt: new Date(2026, 0, seq), ...fields } as Row;
    rows.push(row);
    return row;
  };

  describe("reading", () => {
    const LEGACY = "Written before encryption was switched on";
    const matches = (row: Row, where: any = {}): boolean =>
      Object.entries(where).every(([k, v]: [string, any]) => {
        if (k === "NOT") return Object.entries(v).every(([nk, nv]) => row[nk] !== nv);
        if (v && typeof v === "object" && "in" in v) return v.in.includes(row[k]);
        if (v && typeof v === "object" && "not" in v) return row[k] !== v.not;
        return row[k] === v;
      });

    beforeEach(() => {
      Object.assign(prisma.message, {
        findMany: async ({ where, orderBy, take }: any) => {
          const found = rows.filter((r) => matches(r, where)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
          if (orderBy?.createdAt === "desc") found.reverse();
          return found.slice(0, take ?? found.length).map((r) => ({ ...r }));
        },
        findUnique: async ({ where }: any) => {
          const found = rows.find((r) => matches(r, where));
          return found ? { ...found } : null;
        },
        findFirst: async ({ where }: any) => {
          const found = rows.find((r) => matches(r, where));
          return found ? { ...found } : null;
        },
      });
    });

    it("listMessagesByConsultation opens sealed text, reads old plain text as it is, and leaves out one it cannot open", async () => {
      seed({ content: sealedWith(KEY, SECRET) });
      seed({ content: LEGACY });
      seed({ content: sealedWith(OTHER_KEY, "sealed with a key we do not hold") });
      const listed = await ChatRepo.listMessagesByConsultation("c1");
      expect(listed.map((m) => m.content)).to.deep.equal([SECRET, LEGACY]);
    });

    it("findReplyState opens the partial reply, and treats one it cannot open as absent without losing the turn", async () => {
      const ok = seed({ content: SECRET, replyStatus: "PENDING", pendingReplyContent: sealedWith(KEY, "Under the Rental Act", "Message.pendingReplyContent") });
      const bad = seed({ content: SECRET, replyStatus: "PENDING", pendingReplyContent: sealedWith(OTHER_KEY, "lost", "Message.pendingReplyContent") });
      expect((await ChatRepo.findReplyState(ok.id))?.pendingReplyContent).to.equal("Under the Rental Act");
      const lost = await ChatRepo.findReplyState(bad.id);
      expect(lost?.replyStatus).to.equal("PENDING");
      expect(lost?.pendingReplyContent).to.equal(null);
    });

    it("findUserMessageContent opens the text, and is null when it cannot be opened", async () => {
      const ok = seed({ content: sealedWith(KEY, SECRET) });
      const bad = seed({ content: sealedWith(OTHER_KEY, "lost") });
      expect(await ChatRepo.findUserMessageContent(ok.id)).to.equal(SECRET);
      expect(await ChatRepo.findUserMessageContent(bad.id)).to.equal(null);
    });

    it("findAssistantRepliesByParent opens each reply and leaves out one it cannot open", async () => {
      seed({ role: "assistant", parentMessageId: "p1", content: sealedWith(KEY, "First topic") });
      seed({ role: "assistant", parentMessageId: "p1", content: sealedWith(OTHER_KEY, "lost") });
      seed({ role: "assistant", parentMessageId: "p1", content: LEGACY });
      const replies = await ChatRepo.findAssistantRepliesByParent("p1");
      expect(replies.map((r) => r.content)).to.deep.equal(["First topic", LEGACY]);
    });

    it("findManyByIds opens each message and leaves out one it cannot open", async () => {
      const a = seed({ content: sealedWith(KEY, SECRET) });
      const b = seed({ content: sealedWith(OTHER_KEY, "lost") });
      const c = seed({ content: LEGACY });
      const found = await ChatRepo.findManyByIds([a.id, b.id, c.id]);
      expect(found.map((m) => m.content)).to.deep.equal([SECRET, LEGACY]);
    });

    it("listRecentUserMessageContents opens the text, skips blank sends, and leaves out one it cannot open", async () => {
      seed({ content: sealedWith(KEY, "older question") });
      seed({ content: "" });
      seed({ content: sealedWith(OTHER_KEY, "lost") });
      seed({ content: LEGACY });
      expect(await ChatRepo.listRecentUserMessageContents("c1", 10)).to.deep.equal(["older question", LEGACY]);
    });

    it("the trace pane's promptsByMessageId opens each prompt and leaves out one it cannot open", async () => {
      const a = seed({ content: sealedWith(KEY, SECRET) });
      const b = seed({ content: sealedWith(OTHER_KEY, "lost") });
      const c = seed({ content: LEGACY });
      const prompts = await TraceRepo.promptsByMessageId([a.id, b.id, c.id]);
      expect([...prompts]).to.deep.equal([[a.id, SECRET], [c.id, LEGACY]]);
    });

    it("findMessageById opens the text, and is null when it cannot be opened", async () => {
      const ok = seed({ content: sealedWith(KEY, SECRET) });
      const bad = seed({ content: sealedWith(OTHER_KEY, "lost") });
      expect((await ChatRepo.findMessageById(ok.id))?.content).to.equal(SECRET);
      expect(await ChatRepo.findMessageById(bad.id)).to.equal(null);
    });

    it("findLatestAssistantMessage opens the text, and is null when it cannot be opened", async () => {
      seed({ role: "assistant", parentMessageId: "p1", content: sealedWith(KEY, "The deposit must be returned") });
      expect((await ChatRepo.findLatestAssistantMessage("c1"))?.content).to.equal("The deposit must be returned");
      rows.length = 0;
      seed({ role: "assistant", parentMessageId: "p1", content: sealedWith(OTHER_KEY, "lost") });
      expect(await ChatRepo.findLatestAssistantMessage("c1")).to.equal(null);
    });
  });

  describe("writing", () => {
    it("createMessage stores the text sealed and hands the caller plain text", async () => {
      const created = await ChatRepo.createMessage("c1", "user", SECRET, "u1");
      expect(created.content).to.equal(SECRET);
      expect(rows[0].content.startsWith("enc1:")).to.equal(true);
      expect(rows[0].content).to.not.include("landlord");
    });

    it("keeps an empty message empty, so the blank file-only filter still matches it", async () => {
      await ChatRepo.createMessage("c1", "user", "", "u1");
      expect(rows[0].content).to.equal("");
    });

    it("stores plain text while FIELD_ENCRYPTION_ENABLED is off, so chat keeps working", async () => {
      cfg.FIELD_ENCRYPTION_ENABLED = false;
      const created = await ChatRepo.createMessage("c1", "user", SECRET, "u1");
      expect(created.content).to.equal(SECRET);
      expect(rows[0].content).to.equal(SECRET);
    });

    it("checkpointPendingReply seals the partial reply and hands the caller plain text", async () => {
      const turn = await ChatRepo.createMessage("c1", "user", SECRET, "u1");
      const updated = await ChatRepo.checkpointPendingReply(turn.id, "Under the Rental Act you are entitled to");
      expect(updated.pendingReplyContent).to.equal("Under the Rental Act you are entitled to");
      expect(rows[0].pendingReplyContent!.startsWith("enc1:")).to.equal(true);
      expect(rows[0].pendingReplyContent).to.not.include("Rental");
    });
  });
});
