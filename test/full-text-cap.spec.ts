/** DocumentChunkRepo.findFullTextsByDocuments reads each document's chunks a page at a time and
 * stops once it has `maxCharsPerDocument` characters (default FULL_TEXT_MAX_CHARS_PER_DOCUMENT).
 * Loading every chunk of a huge upload — a 45MB spreadsheet is ~112M characters — in several
 * parallel case-analysis jobs ran the API out of heap.
 *
 * No live Postgres: a fake client serves caseDocumentChunk.findMany from memory, honouring the
 * same where/orderBy/take the repository sends, and counts the rows it hands out.
 */
import { expect } from "chai";
import { describe, it } from "mocha";
import DocumentChunkRepo, { FULL_TEXT_MAX_CHARS_PER_DOCUMENT } from "../src/repositories/document-chunk.repository";

function fakeClient(chunksByDocument: Record<string, string[]>) {
  const served = { rows: 0, queries: 0 };
  const client = {
    caseDocumentChunk: {
      findMany: async (args: { where: { caseDocumentId: string; chunkIndex: { gt: number } }; take: number }) => {
        served.queries += 1;
        const texts = chunksByDocument[args.where.caseDocumentId] ?? [];
        const rows = texts
          .map((chunkText, chunkIndex) => ({ chunkIndex, chunkText }))
          .filter((r) => r.chunkIndex > args.where.chunkIndex.gt)
          .slice(0, args.take);
        served.rows += rows.length;
        return rows;
      },
    },
  };
  return { client: client as any, served };
}

describe("DocumentChunkRepo.findFullTextsByDocuments — capped full text", () => {
  it("joins a small document's chunks in order, exactly as before", async () => {
    const { client } = fakeClient({ d1: ["first", "second", "third"], d2: ["only"] });
    const texts = await DocumentChunkRepo.findFullTextsByDocuments(["d1", "d2", "missing"], {}, client);
    expect(texts.get("d1")).to.equal("first\nsecond\nthird");
    expect(texts.get("d2")).to.equal("only");
    expect(texts.has("missing")).to.equal(false);
  });

  it("pages past 200 chunks and keeps them in order", async () => {
    const chunks = Array.from({ length: 450 }, (_, i) => `c${i}`);
    const { client, served } = fakeClient({ d1: chunks });
    const texts = await DocumentChunkRepo.findFullTextsByDocuments(["d1"], {}, client);
    expect(texts.get("d1")).to.equal(chunks.join("\n"));
    expect(served.queries).to.equal(3);
  });

  it("stops reading once a document has maxCharsPerDocument characters", async () => {
    const chunks = Array.from({ length: 1_000 }, (_, i) => `${i}`.padEnd(1_000, "x"));
    const { client, served } = fakeClient({ d1: chunks });
    const texts = await DocumentChunkRepo.findFullTextsByDocuments(["d1"], { maxCharsPerDocument: 12_000 }, client);
    expect(texts.get("d1")).to.equal(chunks.join("\n").slice(0, 12_000));
    expect(served.rows).to.be.at.most(200);
    expect(served.queries).to.equal(1);
  });

  it("caps at FULL_TEXT_MAX_CHARS_PER_DOCUMENT by default, without reading the rest", async () => {
    const chunk = "y".repeat(8_000);
    const total = Math.ceil((FULL_TEXT_MAX_CHARS_PER_DOCUMENT * 3) / 8_000);
    const { client, served } = fakeClient({ huge: Array.from({ length: total }, () => chunk) });
    const texts = await DocumentChunkRepo.findFullTextsByDocuments(["huge"], {}, client);
    expect(texts.get("huge")!.length).to.equal(FULL_TEXT_MAX_CHARS_PER_DOCUMENT);
    expect(served.rows).to.be.below(total / 2);
  });

  it("findByDocument stops paging at the chunk that reaches maxChars", async () => {
    // findByDocument pages with $queryRaw`… LIMIT ${limit} OFFSET ${offset}`; the fake reads those values.
    const all = Array.from({ length: 1_000 }, (_, i) => ({ id: `c${i}`, caseDocumentId: "d1", chunkIndex: i, chunkText: "z".repeat(1_000), charCount: 1_000, createdAt: new Date() }));
    let queries = 0;
    const client = {
      $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        queries += 1;
        const [, limit, offset] = values as [string, number, number];
        return all.slice(offset, offset + limit);
      },
    };
    const rows = await DocumentChunkRepo.findByDocument("d1", { maxChars: 250_500 }, client as any);
    expect(rows.length).to.equal(251);
    expect(rows.map((r) => r.chunkIndex)).to.deep.equal(Array.from({ length: 251 }, (_, i) => i));
    expect(queries).to.equal(2);
  });

  it("caps each document separately", async () => {
    const { client } = fakeClient({ big: ["a".repeat(50), "b".repeat(50)], small: ["tiny"] });
    const texts = await DocumentChunkRepo.findFullTextsByDocuments(["big", "small"], { maxCharsPerDocument: 60 }, client);
    expect(texts.get("big")).to.equal(`${"a".repeat(50)}\n${"b".repeat(9)}`);
    expect(texts.get("small")).to.equal("tiny");
  });
});
