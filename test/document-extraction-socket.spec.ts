/**
 * DocumentExtractionSvc pushes live status over the existing socket.io notification channel
 * (lib/socket.ts's emitToUser) — document:started / document:ready / document:failed /
 * document:retrying — the same best-effort pattern as chat:* events. Document.ragStatus in the DB
 * stays the source of truth; a failed or skipped emit must never change a job's outcome.
 *
 * No AWS/DB/real sockets: repositories, S3, extraction, embedding and emitToUser are
 * monkeypatched on the CommonJS module objects (same pattern as chat-generation-queue.spec.ts).
 */
import { expect } from "chai";
import { describe, it, beforeEach, afterEach } from "mocha";
import { Prisma } from "@prisma/client";

import * as socketLib from "../src/lib/socket";
import * as s3 from "../src/utils/s3";
import * as textExtraction from "../src/utils/document-text-extraction";
import * as embedding from "../src/utils/embedding";
import * as chatWonder from "../src/utils/chatWonder";
import prisma from "../src/lib/prisma";
import DocumentRepo from "../src/repositories/document.repository";
import DocumentChunkRepo from "../src/repositories/document-chunk.repository";
import DocumentExtractionSvc, { EMBED_ROUND_CHUNKS } from "../src/services/document-extraction.service";

interface Emitted {
  userId: string;
  event: string;
  payload: any;
}

const baseDoc = {
  id: "doc1",
  userId: "user1",
  caseId: null as string | null,
  consultationId: "consult1" as string | null,
  name: "contract.pdf",
  mimeType: "application/pdf",
  fileSize: 1234,
  category: null as string | null,
  ragStatus: "PENDING",
  file: { s3Key: "k/contract.pdf" },
};

describe("DocumentExtractionSvc socket events", () => {
  const originals = {
    emitToUser: socketLib.emitToUser,
    findByIdWithFile: DocumentRepo.findByIdWithFile,
    updateRagStatus: DocumentRepo.updateRagStatus,
    updateExtractionMeta: DocumentRepo.updateExtractionMeta,
    updateCategory: DocumentRepo.updateCategory,
    downloadObjectToTempFile: (s3 as any).downloadObjectToTempFile,
    extractPagesFromFile: (textExtraction as any).extractPagesFromFile,
    embedTexts: (embedding as any).embedTexts,
    categorizeDocument: (chatWonder as any).categorizeDocument,
    transaction: (prisma as any).$transaction,
    deleteByDocument: DocumentChunkRepo.deleteByDocument,
    insertMany: DocumentChunkRepo.insertMany,
    verify: DocumentChunkRepo.verify,
  };

  let emitted: Emitted[];
  let statusWrites: string[];
  let doc: typeof baseDoc | null;
  let pages: { pageNumber: number; text: string }[];
  let insertedCount: number;
  let cleanups: number;
  let storageCalls: string[];
  let insertedIndexes: number[];
  const downloadedBytes = 5678;

  beforeEach(() => {
    emitted = [];
    statusWrites = [];
    doc = { ...baseDoc };
    pages = [{ pageNumber: 1, text: "This agreement is entered into by the parties." }];
    insertedCount = 0;

    (socketLib as any).emitToUser = (userId: string, event: string, payload: any) => {
      emitted.push({ userId, event, payload });
    };
    DocumentRepo.findByIdWithFile = (async () => doc) as any;
    DocumentRepo.updateRagStatus = (async (id: string, ragStatus: string) => {
      statusWrites.push(ragStatus);
      return { ...baseDoc, id, ragStatus };
    }) as any;
    DocumentRepo.updateExtractionMeta = (async () => ({})) as any;
    DocumentRepo.updateCategory = (async () => ({})) as any;
    cleanups = 0;
    (s3 as any).downloadObjectToTempFile = async () => ({
      path: "/tmp/doc1",
      bytes: downloadedBytes,
      cleanup: async () => {
        cleanups += 1;
      },
    });
    (textExtraction as any).extractPagesFromFile = async () => ({ pages, method: "text", ocrAttempted: false });
    (embedding as any).embedTexts = async (texts: string[]) => texts.map(() => [0.1, 0.2]);
    (chatWonder as any).categorizeDocument = async () => "Contract";
    storageCalls = [];
    insertedIndexes = [];
    (prisma as any).$transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
      storageCalls.push("transaction");
      return fn({});
    };
    DocumentChunkRepo.deleteByDocument = (async () => {
      storageCalls.push("delete");
      insertedCount = 0;
    }) as any;
    DocumentChunkRepo.insertMany = (async (rows: { chunkIndex: number }[]) => {
      storageCalls.push(`insert:${rows.length}`);
      insertedCount += rows.length;
      insertedIndexes.push(...rows.map((r) => r.chunkIndex));
    }) as any;
    DocumentChunkRepo.verify = (async () => ({ chunkCount: insertedCount, embeddedCount: insertedCount })) as any;
  });

  afterEach(() => {
    (socketLib as any).emitToUser = originals.emitToUser;
    DocumentRepo.findByIdWithFile = originals.findByIdWithFile;
    DocumentRepo.updateRagStatus = originals.updateRagStatus;
    DocumentRepo.updateExtractionMeta = originals.updateExtractionMeta;
    DocumentRepo.updateCategory = originals.updateCategory;
    (s3 as any).downloadObjectToTempFile = originals.downloadObjectToTempFile;
    (textExtraction as any).extractPagesFromFile = originals.extractPagesFromFile;
    (embedding as any).embedTexts = originals.embedTexts;
    (chatWonder as any).categorizeDocument = originals.categorizeDocument;
    (prisma as any).$transaction = originals.transaction;
    DocumentChunkRepo.deleteByDocument = originals.deleteByDocument;
    DocumentChunkRepo.insertMany = originals.insertMany;
    DocumentChunkRepo.verify = originals.verify;
  });

  it("emits document:started then document:ready (with pageCount and category) to the uploader on success", async () => {
    await DocumentExtractionSvc.process("doc1");

    expect(emitted.map((e) => e.event)).to.deep.equal(["document:started", "document:ready"]);
    expect(emitted.every((e) => e.userId === "user1")).to.equal(true);
    expect(emitted[0].payload).to.include({ documentId: "doc1", consultationId: "consult1", ragStatus: "PENDING" });
    expect(emitted[1].payload).to.include({ documentId: "doc1", ragStatus: "READY", pageCount: 1, category: "Contract" });
    expect(statusWrites).to.include("READY");
  });

  it("keeps a client-supplied category instead of the AI's, and reports it on document:ready", async () => {
    doc = { ...baseDoc, category: "Evidence" };
    await DocumentExtractionSvc.process("doc1");

    expect(emitted[1].event).to.equal("document:ready");
    expect(emitted[1].payload.category).to.equal("Evidence");
  });

  it("emits document:failed when the document has no file", async () => {
    doc = { ...baseDoc, file: null } as any;
    await DocumentExtractionSvc.process("doc1");

    expect(emitted.map((e) => e.event)).to.deep.equal(["document:failed"]);
    expect(emitted[0].payload.ragStatus).to.equal("FAILED");
  });

  it("emits document:failed when no text could be extracted", async () => {
    pages = [{ pageNumber: 1, text: "   " }];
    await DocumentExtractionSvc.process("doc1");

    expect(emitted.map((e) => e.event)).to.deep.equal(["document:started", "document:failed"]);
    expect(statusWrites).to.deep.equal(["FAILED"]);
  });

  it("emits document:failed when extraction throws a non-rate-limit error", async () => {
    (embedding as any).embedTexts = async () => {
      throw new Error("boom");
    };
    await DocumentExtractionSvc.process("doc1");

    expect(emitted.map((e) => e.event)).to.deep.equal(["document:started", "document:failed"]);
  });

  it("emits document:retrying and leaves the row PENDING on a 429", async () => {
    (embedding as any).embedTexts = async () => {
      throw Object.assign(new Error("rate limited"), { status: 429 });
    };
    await DocumentExtractionSvc.process("doc1");

    expect(emitted.map((e) => e.event)).to.deep.equal(["document:started", "document:retrying"]);
    expect(emitted[1].payload.ragStatus).to.equal("PENDING");
    expect(statusWrites).to.deep.equal(["PENDING"]);
  });

  it("still resolves READY when the live-push layer throws — a broken socket never fails a job", async () => {
    (socketLib as any).emitToUser = () => {
      throw new Error("socket layer is broken");
    };
    await DocumentExtractionSvc.process("doc1");

    expect(statusWrites).to.include("READY");
    expect(statusWrites).to.not.include("FAILED");
  });

  it("reports the file size (row, then actual download) and removes the temp file", async () => {
    const sizes: number[] = [];
    await DocumentExtractionSvc.process("doc1", { onFileSize: (bytes) => sizes.push(bytes) });

    expect(sizes).to.deep.equal([1234, downloadedBytes]);
    expect(cleanups).to.equal(1);
  });

  it("removes the temp file even when extraction throws", async () => {
    (textExtraction as any).extractPagesFromFile = async () => {
      throw new Error("corrupt file");
    };
    await DocumentExtractionSvc.process("doc1");

    expect(cleanups).to.equal(1);
    expect(statusWrites).to.deep.equal(["FAILED"]);
  });

  it("replaces a small document's chunks in one transaction, as before", async () => {
    await DocumentExtractionSvc.process("doc1");

    expect(storageCalls).to.deep.equal(["transaction", "delete", "insert:1"]);
  });

  /** One page with `count` paragraphs → `count` chunks. */
  const manyChunks = (count: number) => [
    { pageNumber: 1, text: Array.from({ length: count }, (_, i) => `Paragraph ${i}.`).join("\n\n") },
  ];

  it("stores a document over EMBED_ROUND_CHUNKS round by round, with continuous chunk indexes", async () => {
    pages = manyChunks(EMBED_ROUND_CHUNKS + 100);
    await DocumentExtractionSvc.process("doc1");

    expect(storageCalls).to.deep.equal(["delete", `insert:${EMBED_ROUND_CHUNKS}`, "insert:100"]);
    expect(insertedIndexes).to.deep.equal(Array.from({ length: EMBED_ROUND_CHUNKS + 100 }, (_, i) => i));
    expect(statusWrites).to.include("READY");
  });

  it("deletes the partial chunks when a later round fails", async () => {
    pages = manyChunks(EMBED_ROUND_CHUNKS + 100);
    // Fails on the first chunk of round 2.
    (embedding as any).embedTexts = async (texts: string[]) => {
      if (texts.includes(`Paragraph ${EMBED_ROUND_CHUNKS}.`)) throw new Error("embedding outage");
      return texts.map(() => [0.1, 0.2]);
    };
    await DocumentExtractionSvc.process("doc1");

    expect(storageCalls).to.deep.equal(["delete", `insert:${EMBED_ROUND_CHUNKS}`, "delete"]);
    expect(statusWrites).to.deep.equal(["FAILED"]);
  });

  it("emits nothing when the document was deleted mid-extraction (P2025)", async () => {
    DocumentRepo.updateRagStatus = (async () => {
      throw new Prisma.PrismaClientKnownRequestError("gone", { code: "P2025", clientVersion: "test" });
    }) as any;
    (embedding as any).embedTexts = async () => {
      throw new Error("boom");
    };
    await DocumentExtractionSvc.process("doc1");

    expect(emitted.map((e) => e.event)).to.deep.equal(["document:started"]);
  });
});
