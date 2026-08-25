/** OpenAI embedding models cap each input; keep chunks under this. */
export const EMBEDDING_CHAR_CAP = 8000;

export type ChunkingTier = "compact" | "default" | "large" | "bulk";

export type ChunkingProfile = {
  tier: ChunkingTier;
  chunkSize: number;
  overlap: number;
  embeddingBatchSize: number;
  embeddingConcurrency: number;
};

export type ChunkingInput = {
  pageCount: number;
  totalChars: number;
  fileSizeBytes?: number | null;
};

export interface TextChunk {
  text: string;
  pageNumber: number | null;
}

/**
 * Pick chunk size from the uploaded file — short pleadings stay small and precise;
 * 1000-page PDFs use larger chunks so embedding stays bounded.
 */
export function resolveChunkingProfile(input: ChunkingInput): ChunkingProfile {
  const pages = Math.max(0, input.pageCount);
  const chars = Math.max(0, input.totalChars);
  const bytes = Math.max(0, input.fileSizeBytes ?? 0);
  const fileMb = bytes / (1024 * 1024);

  if (pages <= 5 && chars <= 8_000 && fileMb < 2) {
    return {
      tier: "compact",
      chunkSize: 1_200,
      overlap: 200,
      embeddingBatchSize: 100,
      embeddingConcurrency: 2,
    };
  }
  if (pages <= 40 && chars <= 80_000 && fileMb < 8) {
    return {
      tier: "default",
      chunkSize: 2_000,
      overlap: 300,
      embeddingBatchSize: 100,
      embeddingConcurrency: 2,
    };
  }
  if (pages <= 200 && chars <= 400_000 && fileMb < 25) {
    return {
      tier: "large",
      chunkSize: 4_000,
      overlap: 400,
      embeddingBatchSize: 50,
      embeddingConcurrency: 2,
    };
  }
  return {
    tier: "bulk",
    chunkSize: 6_000,
    overlap: 500,
    embeddingBatchSize: 32,
    embeddingConcurrency: 2,
  };
}

/** One-paragraph-per-chunk (ADR 0010). Oversize paragraphs are hard-cut, never dropped. */
export function chunkText(
  text: string,
  pageNumber: number | null = null,
  profile?: Pick<ChunkingProfile, "chunkSize" | "overlap">,
): TextChunk[] {
  const resolved = profile ?? resolveChunkingProfile({ pageCount: 1, totalChars: text.length });
  return chunkParagraphs(text, pageNumber, resolved.chunkSize, resolved.overlap);
}

export function chunkPages(
  pages: { pageNumber: number; text: string }[],
  profile?: Pick<ChunkingProfile, "chunkSize" | "overlap">,
): TextChunk[] {
  const totalChars = pages.reduce((sum, page) => sum + page.text.length, 0);
  const resolved =
    profile ?? resolveChunkingProfile({ pageCount: pages.length, totalChars });
  const chunks: TextChunk[] = [];
  for (const page of pages) {
    chunks.push(
      ...chunkParagraphs(page.text, page.pageNumber, resolved.chunkSize, resolved.overlap),
    );
  }
  return chunks;
}

function chunkParagraphs(
  text: string,
  pageNumber: number | null,
  chunkSize: number,
  overlap: number,
): TextChunk[] {
  const size = Math.min(Math.max(chunkSize, 400), EMBEDDING_CHAR_CAP);
  const stepOverlap = Math.min(Math.max(overlap, 0), Math.floor(size / 2));

  let paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (paragraphs.length <= 1 && text.length > size) {
    paragraphs = text
      .split(/\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
  }

  const chunks: TextChunk[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length > size) {
      for (let i = 0; i < paragraph.length; i += size - stepOverlap) {
        chunks.push({ text: paragraph.slice(i, i + size), pageNumber });
      }
      continue;
    }

    chunks.push({ text: paragraph, pageNumber });
  }

  return chunks;
}
