/** Privileged evidence notes are stored sealed (#343): the notes on a matrix item whose
 * privilegeStatus is not NONE, and the notes of its custody events. Callers always see plain text.
 *
 * No live Postgres: the model delegates are monkeypatched on the shared client with a small
 * in-memory store, same idiom as test/ai-replace-safety.spec.ts. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import prisma from "../src/lib/prisma";
import * as config from "../src/config";
import EvidenceRepo from "../src/repositories/evidence.repository";

type Item = { id: string; caseId: string; documentId: string; notes: string | null; privilegeStatus: string; createdAt: Date };
type Event = { id: string; evidenceMatrixItemId: string; custodianName: string; action: string; occurredAt: Date; notes: string | null };

const KEY = crypto.randomBytes(32).toString("base64");
const SECRET = "Client told us on 3 May that the transfer was a gift";

describe("evidence notes encryption", () => {
  const cfg = config as unknown as Record<string, unknown>;
  const original = {
    enabled: cfg.FIELD_ENCRYPTION_ENABLED,
    key: cfg.FIELD_ENCRYPTION_KEY,
    oldKeys: cfg.FIELD_ENCRYPTION_OLD_KEYS,
    transaction: prisma.$transaction,
    item: { ...prisma.evidenceMatrixItem },
    event: { ...prisma.evidenceCustodyEvent },
  };
  let items: Item[];
  let events: Event[];
  let seq: number;

  const withEvents = (item: Item) => ({
    ...item,
    custodyEvents: events.filter((e) => e.evidenceMatrixItemId === item.id).sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime()).map((e) => ({ ...e })),
  });

  beforeEach(() => {
    cfg.FIELD_ENCRYPTION_ENABLED = true;
    cfg.FIELD_ENCRYPTION_KEY = KEY;
    cfg.FIELD_ENCRYPTION_OLD_KEYS = undefined;
    items = [];
    events = [];
    seq = 0;
    (prisma as any).$transaction = async (fn: any) => fn(prisma);
    Object.assign(prisma.evidenceMatrixItem, {
      findUnique: async ({ where }: any) => {
        const found = where.id ? items.find((i) => i.id === where.id) : items.find((i) => i.caseId === where.caseId_documentId.caseId && i.documentId === where.caseId_documentId.documentId);
        return found ? { ...found } : null;
      },
      findMany: async ({ where }: any) => items.filter((i) => i.caseId === where.caseId).map(withEvents),
      upsert: async ({ where, create, update }: any) => {
        const k = where.caseId_documentId;
        let item = items.find((i) => i.caseId === k.caseId && i.documentId === k.documentId);
        if (item) Object.assign(item, update);
        else {
          item = { id: `item-${++seq}`, notes: null, privilegeStatus: "NONE", createdAt: new Date(), ...create };
          items.push(item);
        }
        return withEvents(item);
      },
    });
    Object.assign(prisma.evidenceCustodyEvent, {
      create: async ({ data }: any) => {
        const event = { id: `event-${++seq}`, notes: null, ...data } as Event;
        events.push(event);
        return { ...event };
      },
      update: async ({ where, data }: any) => {
        const event = events.find((e) => e.id === where.id)!;
        Object.assign(event, data);
        return { ...event };
      },
      findFirst: async ({ where }: any) => {
        const found = events.find((e) => e.id === where.id && e.evidenceMatrixItemId === where.evidenceMatrixItemId);
        return found ? { ...found } : null;
      },
    });
  });

  afterEach(() => {
    cfg.FIELD_ENCRYPTION_ENABLED = original.enabled;
    cfg.FIELD_ENCRYPTION_KEY = original.key;
    cfg.FIELD_ENCRYPTION_OLD_KEYS = original.oldKeys;
    (prisma as any).$transaction = original.transaction;
    Object.assign(prisma.evidenceMatrixItem, original.item);
    Object.assign(prisma.evidenceCustodyEvent, original.event);
  });

  const stored = (id: string) => items.find((i) => i.id === id)!;
  const sealed = (value: string | null) => typeof value === "string" && value.startsWith("enc1:") && !value.includes("transfer");

  it("stores the notes of a privileged item sealed, and returns them plain", async () => {
    const row = await EvidenceRepo.upsertMatrix("case-1", "doc-1", { privilegeStatus: "ATTORNEY_CLIENT", notes: SECRET });
    expect(sealed(stored(row.id).notes)).to.equal(true);
    expect(row.notes).to.equal(SECRET);
  });

  it("stores the notes of a non-privileged item as they are", async () => {
    const row = await EvidenceRepo.upsertMatrix("case-1", "doc-1", { privilegeStatus: "NONE", notes: SECRET });
    expect(stored(row.id).notes).to.equal(SECRET);
  });

  it("does not seal anything while the switch is off", async () => {
    cfg.FIELD_ENCRYPTION_ENABLED = false;
    const row = await EvidenceRepo.upsertMatrix("case-1", "doc-1", { privilegeStatus: "WORK_PRODUCT", notes: SECRET });
    expect(stored(row.id).notes).to.equal(SECRET);
  });

  it("fails loudly, and stores nothing, when it should seal but has no key", async () => {
    cfg.FIELD_ENCRYPTION_KEY = undefined;
    let error: Error | undefined;
    try {
      await EvidenceRepo.upsertMatrix("case-1", "doc-1", { privilegeStatus: "ATTORNEY_CLIENT", notes: SECRET });
    } catch (err) {
      error = err as Error;
    }
    expect(error?.message).to.match(/FIELD_ENCRYPTION_KEY/);
    expect(items).to.have.length(0);
  });

  it("still lets a non-privileged item be edited when no key is configured", async () => {
    cfg.FIELD_ENCRYPTION_KEY = undefined;
    const row = await EvidenceRepo.upsertMatrix("case-1", "doc-1", { notes: "ordinary" });
    expect(stored(row.id).notes).to.equal("ordinary");
  });

  it("seals the notes and the custody notes when an item becomes privileged, without being sent the notes again", async () => {
    const row = await EvidenceRepo.upsertMatrix("case-1", "doc-1", { notes: SECRET });
    await EvidenceRepo.addCustodyEvent(row.id, { custodianName: "A", action: "received", occurredAt: new Date(), notes: "left with courier" });
    expect(stored(row.id).notes).to.equal(SECRET);

    const after = await EvidenceRepo.upsertMatrix("case-1", "doc-1", { privilegeStatus: "ATTORNEY_CLIENT" });
    expect(sealed(stored(row.id).notes)).to.equal(true);
    expect(events[0]!.notes!.startsWith("enc1:")).to.equal(true);
    expect(after.notes).to.equal(SECRET);
    expect(after.custodyEvents[0]!.notes).to.equal("left with courier");
  });

  it("opens the notes and the custody notes again when an item stops being privileged", async () => {
    const row = await EvidenceRepo.upsertMatrix("case-1", "doc-1", { privilegeStatus: "WORK_PRODUCT", notes: SECRET });
    await EvidenceRepo.addCustodyEvent(row.id, { custodianName: "A", action: "received", occurredAt: new Date(), notes: "left with courier" });
    expect(events[0]!.notes!.startsWith("enc1:")).to.equal(true);

    await EvidenceRepo.upsertMatrix("case-1", "doc-1", { privilegeStatus: "NONE" });
    expect(stored(row.id).notes).to.equal(SECRET);
    expect(events[0]!.notes).to.equal("left with courier");
  });

  it("seals the notes of a new custody event on a privileged item, and not on another", async () => {
    const privileged = await EvidenceRepo.upsertMatrix("case-1", "doc-1", { privilegeStatus: "ATTORNEY_CLIENT" });
    const ordinary = await EvidenceRepo.upsertMatrix("case-1", "doc-2", {});
    const a = await EvidenceRepo.addCustodyEvent(privileged.id, { custodianName: "A", action: "received", occurredAt: new Date(), notes: "private detail" });
    const b = await EvidenceRepo.addCustodyEvent(ordinary.id, { custodianName: "B", action: "received", occurredAt: new Date(), notes: "ordinary detail" });
    expect(events.find((e) => e.id === a.id)!.notes!.startsWith("enc1:")).to.equal(true);
    expect(a.notes).to.equal("private detail");
    expect(events.find((e) => e.id === b.id)!.notes).to.equal("ordinary detail");
  });

  it("returns plain notes from every read", async () => {
    const row = await EvidenceRepo.upsertMatrix("case-1", "doc-1", { privilegeStatus: "ATTORNEY_CLIENT", notes: SECRET });
    const event = await EvidenceRepo.addCustodyEvent(row.id, { custodianName: "A", action: "received", occurredAt: new Date(), notes: "private detail" });

    const list = await EvidenceRepo.listMatrix("case-1");
    expect(list[0]!.notes).to.equal(SECRET);
    expect(list[0]!.custodyEvents[0]!.notes).to.equal("private detail");
    expect((await EvidenceRepo.findMatrixItem("case-1", "doc-1"))!.notes).to.equal(SECRET);
    expect((await EvidenceRepo.findCustodyEvent(row.id, event.id))!.notes).to.equal("private detail");
  });

  it("keeps working after the key is rotated and the old key is listed", async () => {
    const row = await EvidenceRepo.upsertMatrix("case-1", "doc-1", { privilegeStatus: "ATTORNEY_CLIENT", notes: SECRET });
    cfg.FIELD_ENCRYPTION_OLD_KEYS = KEY;
    cfg.FIELD_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
    expect((await EvidenceRepo.findMatrixItem("case-1", "doc-1"))!.notes).to.equal(SECRET);

    // An edit that sends no notes re-seals them under the new key.
    const oldKeyId = stored(row.id).notes!.split(":")[1];
    await EvidenceRepo.upsertMatrix("case-1", "doc-1", { authenticity: "verified" });
    expect(stored(row.id).notes!.split(":")[1]).to.equal(oldKeyId); // already sealed: left as it is
    await EvidenceRepo.upsertMatrix("case-1", "doc-1", { notes: SECRET });
    expect(stored(row.id).notes!.split(":")[1]).to.not.equal(oldKeyId);
  });

  it("never overwrites sealed notes it cannot open", async () => {
    const row = await EvidenceRepo.upsertMatrix("case-1", "doc-1", { privilegeStatus: "ATTORNEY_CLIENT", notes: SECRET });
    const before = stored(row.id).notes;
    cfg.FIELD_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64"); // old key lost
    cfg.FIELD_ENCRYPTION_ENABLED = false;

    const read = await EvidenceRepo.findMatrixItem("case-1", "doc-1");
    expect(read!.notes).to.equal(null); // unreadable, not an error and not the ciphertext
    await EvidenceRepo.upsertMatrix("case-1", "doc-1", { privilegeStatus: "NONE" }); // would unseal; cannot
    expect(stored(row.id).notes).to.equal(before);
  });

  it("opens notes whether or not the switch is on", async () => {
    const row = await EvidenceRepo.upsertMatrix("case-1", "doc-1", { privilegeStatus: "ATTORNEY_CLIENT", notes: SECRET });
    expect(sealed(stored(row.id).notes)).to.equal(true);
    cfg.FIELD_ENCRYPTION_ENABLED = false;
    expect((await EvidenceRepo.findMatrixItem("case-1", "doc-1"))!.notes).to.equal(SECRET);
  });
});
