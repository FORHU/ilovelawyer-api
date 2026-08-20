import DocumentChunkRepo from "../repositories/document-chunk.repository";
import { extractFacts } from "./fact-extract";

export type ReadyDoc = { id: string; name: string };

export async function buildFactExcerptPack(ready: ReadyDoc[]): Promise<{ chunkIds: string[]; text: string; factCount: number }> {
  const allChunks = [];
  for (const doc of ready) {
    const ids = await DocumentChunkRepo.findIdsByDocument(doc.id);
    const rows = await DocumentChunkRepo.findTextsByIds(ids);
    allChunks.push(...rows);
  }

  const factChunks = allChunks.filter((chunk) => extractFacts(chunk.chunkText).length > 0);
  const pool = factChunks.length > 0 ? factChunks : allChunks;
  const chosen = sampleByIndex(pool, 32);

  const text = chosen
    .map((chunk) => {
      const page = chunk.pageNumber != null ? ` p.${chunk.pageNumber}` : "";
      return `[${chunk.caseDocumentId}${page}]\n${chunk.chunkText.slice(0, 700)}`;
    })
    .join("\n\n")
    .slice(0, 16000);

  return { chunkIds: chosen.map((chunk) => chunk.id), text, factCount: factChunks.length };
}

function sampleByIndex<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const picked: T[] = [];
  const step = (items.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) {
    const item = items[Math.round(i * step)];
    if (item && picked[picked.length - 1] !== item) picked.push(item);
  }
  return picked;
}
