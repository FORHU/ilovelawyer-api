const CHUNK_SIZE = 2000;
const CHUNK_OVERLAP = 300;

export interface TextChunk {
  text: string;
  pageNumber: number | null;
}

/** Paragraph-boundary-aware chunker (ADR 0010): packs paragraphs into ~2000-char chunks with a
 * ~300-char overlap carried into the next chunk's start. A single paragraph larger than
 * CHUNK_SIZE is hard-cut into fixed-size (still overlapping) pieces rather than dropped. */
export function chunkText(text: string, pageNumber: number | null = null): TextChunk[] {
  return chunkParagraphs(text, pageNumber);
}

export function chunkPages(pages: { pageNumber: number; text: string }[]): TextChunk[] {
  const chunks: TextChunk[] = [];
  for (const page of pages) {
    chunks.push(...chunkParagraphs(page.text, page.pageNumber));
  }
  return chunks;
}

function chunkParagraphs(text: string, pageNumber: number | null): TextChunk[] {
  let paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (paragraphs.length <= 1 && text.length > CHUNK_SIZE) {
    paragraphs = text
      .split(/\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
  }

  const chunks: TextChunk[] = [];
  let current = "";

  const flush = () => {
    if (current.trim().length > 0) chunks.push({ text: current.trim(), pageNumber });
    current = current.slice(-CHUNK_OVERLAP);
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > CHUNK_SIZE) {
      flush();
      current = "";
      for (let i = 0; i < paragraph.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
        chunks.push({ text: paragraph.slice(i, i + CHUNK_SIZE), pageNumber });
      }
      continue;
    }

    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > CHUNK_SIZE) flush();
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }

  if (current.trim().length > 0) chunks.push({ text: current.trim(), pageNumber });
  return chunks;
}
