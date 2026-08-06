import crypto from "crypto";
import prisma from "../lib/prisma";
import { Prisma } from "@prisma/client";

type DbClient = Prisma.TransactionClient | typeof prisma;

interface NewChunk {
  userDocumentId: string;
  chunkIndex: number;
  chunkText: string;
  charCount: number;
  embedding: number[];
}

export default class CaseDocumentChunkRepo {
  static async deleteByDocument(userDocumentId: string, client: DbClient = prisma): Promise<void> {
    await client.$executeRaw`DELETE FROM "CaseDocumentChunk" WHERE "userDocumentId" = ${userDocumentId}`;
  }

  static async insertMany(chunks: NewChunk[], client: DbClient = prisma): Promise<void> {
    for (const chunk of chunks) {
      const vector = `[${chunk.embedding.join(",")}]`;
      await client.$executeRawUnsafe(
        `INSERT INTO "CaseDocumentChunk" (id, "userDocumentId", "chunkIndex", "chunkText", "charCount", embedding, "createdAt")
         VALUES ($1, $2, $3, $4, $5, $6::vector, now())`,
        crypto.randomUUID(),
        chunk.userDocumentId,
        chunk.chunkIndex,
        chunk.chunkText,
        chunk.charCount,
        vector,
      );
    }
  }
}
