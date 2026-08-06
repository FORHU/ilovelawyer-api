const CHUNK_SIZE = 2000;
const CHUNK_OVERLAP = 300;

/** Paragraph-boundary-aware chunker (ADR 0010): packs paragraphs into ~2000-char chunks with a
 * ~300-char overlap carried into the next chunk's start. A single paragraph larger than
 * CHUNK_SIZE is hard-cut into fixed-size (still overlapping) pieces rather than dropped. */
export function chunkText(text: string): string[] {
  let paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  // pdf-parse output often has no blank lines between paragraphs — fall back to single newlines
  // so the whole document doesn't collapse into one oversized "paragraph".
  if (paragraphs.length <= 1 && text.length > CHUNK_SIZE) {
    paragraphs = text
      .split(/\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
  }

  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current.trim().length > 0) chunks.push(current.trim());
    current = current.slice(-CHUNK_OVERLAP);
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > CHUNK_SIZE) {
      flush();
      current = "";
      for (let i = 0; i < paragraph.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
        chunks.push(paragraph.slice(i, i + CHUNK_SIZE));
      }
      continue;
    }

    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > CHUNK_SIZE) flush();
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }

  if (current.trim().length > 0) chunks.push(current.trim());

  return chunks;
}
