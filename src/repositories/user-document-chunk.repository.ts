import crypto from "crypto";
import prisma from "../lib/prisma";

interface ChunkInput {
  chunkIndex: number;
  chunkText: string;
  charCount: number;
  embedding: number[];
}

interface ChunkVectorSearchRow {
  chunk_text: string;
  doc_name: string;
  similarity: number;
}

export default class UserDocumentChunkRepo {
  // `embedding` is an Unsupported("vector(1536)") column, so it's absent from Prisma
  // Client's generated types entirely — writes go through $executeRawUnsafe instead,
  // same as LegalRagRepo does for reads on the equivalent legal-rag column.
  static async insertMany(documentId: string, chunks: ChunkInput[]): Promise<void> {
    for (const chunk of chunks) {
      const vector = `[${chunk.embedding.join(",")}]`;
      await prisma.$executeRawUnsafe(
        `INSERT INTO "UserDocumentChunk" (id, "documentId", "chunkIndex", "chunkText", "charCount", "embedding")
         VALUES ($1, $2, $3, $4, $5, $6::vector)`,
        crypto.randomUUID(),
        documentId,
        chunk.chunkIndex,
        chunk.chunkText,
        chunk.charCount,
        vector,
      );
    }
  }

  /** Chunks belonging to Documents linked to `caseId`, scoped to `userId` as a
   * defense-in-depth check (the Case is already user-scoped, so this shouldn't ever
   * mismatch, but don't rely on that implicitly). */
  static async vectorSearch(
    caseId: string,
    userId: string,
    embedding: number[],
    { limit = 8, minSimilarity = 0.3 }: { limit?: number; minSimilarity?: number } = {},
  ): Promise<ChunkVectorSearchRow[]> {
    const vector = `[${embedding.join(",")}]`;
    return prisma.$queryRawUnsafe<ChunkVectorSearchRow[]>(
      `SELECT c."chunkText" AS chunk_text, d."name" AS doc_name,
              1 - (c."embedding" <=> $1::vector) AS similarity
       FROM "UserDocumentChunk" c
       JOIN "UserDocument" d ON d.id = c."documentId"
       WHERE d."caseId" = $2 AND d."userId" = $3
         AND 1 - (c."embedding" <=> $1::vector) >= $4
       ORDER BY c."embedding" <=> $1::vector
       LIMIT $5`,
      vector,
      caseId,
      userId,
      minSimilarity,
      limit,
    );
  }
}
