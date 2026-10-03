import { expect } from "chai";
import { describe, it, afterEach } from "mocha";
import DocumentChunkRepo from "../src/repositories/document-chunk.repository";
import {
  allocatePerDocumentBudget,
  boilerplateKeys,
  buildFactExcerptPack,
  mentionsFact,
  PASSAGE_CHARS,
  toPassages,
  type ChunkRow,
} from "../src/utils/case-document-excerpts";

type Item = { id: string };

function pool(prefix: string, count: number): Item[] {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}` }));
}

function docIdsOf(items: Item[]): Set<string> {
  return new Set(items.map((item) => item.id.split("-")[0]));
}

describe("allocatePerDocumentBudget", () => {
  it("gives every non-empty pool at least a floor share on a 20-document case (the reported bug)", () => {
    // 20 exhibits, wildly uneven in size — one 300-chunk ledger plus nineteen 2-chunk letters.
    // The previous flat case-wide top-32 selection would let the ledger's textually-similar
    // chunks fill most or all of the 32 slots, leaving several of the 2-chunk exhibits with zero
    // representation — reproducing the benchmark's "Exhibit D/N is unavailable" failure.
    const pools = [pool("ledger", 300), ...Array.from({ length: 19 }, (_, i) => pool(`ex${i}`, 2))];

    const result = allocatePerDocumentBudget(pools, 32);

    result.forEach((chosen, i) => {
      expect(chosen.length, `pool ${i} got zero chunks`).to.be.greaterThan(0);
    });
  });

  it("never selects more than a pool actually has", () => {
    const pools = [pool("a", 1), pool("b", 3), pool("c", 50)];
    const result = allocatePerDocumentBudget(pools, 32);
    result.forEach((chosen, i) => expect(chosen.length).to.be.at.most(pools[i].length));
  });

  it("distributes leftover budget to pools with more content once every pool has its floor", () => {
    // budget 10, 2 pools -> base quota 5 each. Pool "small" only has 2 items, so 3 slots go
    // unused by it and should roll over to "big" instead of being wasted.
    const pools = [pool("small", 2), pool("big", 20)];
    const result = allocatePerDocumentBudget(pools, 10);
    const [small, big] = result;
    expect(small.length).to.equal(2);
    expect(big.length).to.equal(8); // 5 (floor) + 3 (small's unused floor share)
  });

  it("returns all items unselected as empty arrays when the total budget is exhausted by earlier pools' floors", () => {
    const pools = [pool("a", 5), pool("b", 5), pool("c", 5)];
    // budget smaller than pool count: floor share is still at least 1 per pool by construction.
    const result = allocatePerDocumentBudget(pools, 3);
    result.forEach((chosen) => expect(chosen.length).to.equal(1));
  });

  it("handles a totally empty case (no documents) without throwing", () => {
    expect(allocatePerDocumentBudget([], 32)).to.deep.equal([]);
  });

  it("skips empty pools without giving them a phantom floor share", () => {
    const pools = [pool("a", 5), [], pool("c", 5)];
    const result = allocatePerDocumentBudget(pools, 32);
    expect(result[1]).to.deep.equal([]);
    expect(result[0].length).to.be.greaterThan(0);
    expect(result[2].length).to.be.greaterThan(0);
  });

  it("never selects the same item twice within one pool", () => {
    const pools = [pool("a", 40)];
    const result = allocatePerDocumentBudget(pools, 32);
    const ids = result[0].map((item) => item.id);
    expect(new Set(ids).size).to.equal(ids.length);
  });

  // Sanity check tying the unit back to the reported symptom in plain terms.
  it("covers every exhibit letter in a 20-exhibit case, matching the benchmark's Exhibits A-T", () => {
    const letters = "ABCDEFGHIJKLMNOPQRST".split("");
    const pools = letters.map((letter, i) =>
      // Exhibit D (a short admission letter) has just 1 chunk; everything else has 15.
      pool(letter, letter === "D" ? 1 : 15),
    );
    const result = allocatePerDocumentBudget(pools, 32);
    const coveredLetters = docIdsOf(result.flat());
    for (const letter of letters) {
      expect(coveredLetters.has(letter), `Exhibit ${letter} got no chunks`).to.equal(true);
    }
  });
});

let n = 0;
const row = (doc: string, chunkIndex: number, pageNumber: number | null, chunkText: string): ChunkRow => ({
  id: `${doc}-c${chunkIndex}-${n++}`,
  caseDocumentId: doc,
  chunkIndex,
  pageNumber,
  chunkText,
});

/** A bundle document the way the Doyle and Test 1 PDFs were chunked: one chunk per line, and every
 * page opening with the bundle banner and the case's running header. */
function lineChunkedDoc(doc: string, docNo: number, pages: number): ChunkRow[] {
  const rows: ChunkRow[] = [];
  let i = 0;
  for (let page = 1; page <= pages; page++) {
    rows.push(row(doc, i++, page, `BUNDLE DOCUMENT ${docNo} OF 21 FICTIONAL TEST MATERIAL - NOT A REAL CASE`));
    rows.push(row(doc, i++, page, `R v Doyle (T2026/0091) | Reading Crown Court D${docNo} / p.${page}`));
    // Distinct words per line: boilerplate detection ignores digits, so lines that differ only by
    // a number would all read as one repeated header.
    for (let line = 0; line < 12; line++) {
      const word = [docNo, page, line].map((k) => String.fromCharCode(97 + k)).join("");
      rows.push(row(doc, i++, page, `The witness ${word} saw Doyle leave the workshop that evening.`));
    }
  }
  return rows;
}

describe("boilerplateKeys", () => {
  it("flags short text repeated on three or more pages, ignoring the numbers in it", () => {
    const rows = [1, 2, 3].map((p) => row("a", p, p, `R v Doyle | D1 / p.${p}`));
    expect(boilerplateKeys(rows).size).to.equal(1);
  });

  it("keeps text that repeats on fewer pages, or is long", () => {
    const long = "x".repeat(300);
    const rows = [row("a", 0, 1, "Item 1.1"), row("a", 1, 2, "Item 1.2"), ...[1, 2, 3].map((p) => row("a", 10 + p, p, long))];
    expect(boilerplateKeys(rows).size).to.equal(0);
  });
});

describe("toPassages", () => {
  it("merges line-sized chunks into passages that never cross a page", () => {
    const rows = [row("a", 0, 1, "one"), row("a", 1, 1, "two"), row("a", 2, 2, "three")];
    const passages = toPassages(rows);
    expect(passages.map((p) => p.text)).to.deep.equal(["one\ntwo", "three"]);
    expect(passages.map((p) => p.pageNumber)).to.deep.equal([1, 2]);
    expect(passages[0].chunkIds).to.have.length(2);
  });

  it("caps a passage at PASSAGE_CHARS, including one oversized chunk", () => {
    const passages = toPassages([row("a", 0, 1, "y".repeat(PASSAGE_CHARS * 3))]);
    expect(passages[0].text).to.have.length(PASSAGE_CHARS);
  });
});

describe("mentionsFact", () => {
  it("reads UK dates and sterling amounts", () => {
    expect(mentionsFact("The visit on 24 September 2026 was recorded.")).to.equal(true);
    expect(mentionsFact("He was owed £4,180 in wages.")).to.equal(true);
    expect(mentionsFact("He left the workshop.")).to.equal(false);
  });
});

describe("buildFactExcerptPack", () => {
  const original = { ids: DocumentChunkRepo.findIdsByDocument, texts: DocumentChunkRepo.findTextsByIds };
  afterEach(() => {
    DocumentChunkRepo.findIdsByDocument = original.ids;
    DocumentChunkRepo.findTextsByIds = original.texts;
  });

  // The R v Doyle QA run: 21 READY documents, and every findings panel and the strategy map said
  // "the extracts contain only document headings". With a 32-chunk budget each document got its
  // banner and running header and nothing else.
  it("sends body text, not banners and running headers, for a 21-document line-chunked case", async () => {
    const docs = Array.from({ length: 21 }, (_, i) => ({ id: `doc${i + 1}`, name: `D${i + 1}.pdf` }));
    const rowsByDoc = new Map(docs.map((d, i) => [d.id, lineChunkedDoc(d.id, i + 1, 4)]));
    const byId = new Map([...rowsByDoc.values()].flat().map((r) => [r.id, r]));
    DocumentChunkRepo.findIdsByDocument = (async (docId: string) => rowsByDoc.get(docId)!.map((r) => r.id)) as any;
    DocumentChunkRepo.findTextsByIds = (async (ids: string[]) => ids.map((id) => byId.get(id)!)) as any;

    const pack = await buildFactExcerptPack(docs);

    expect(pack.text).not.to.include("BUNDLE DOCUMENT");
    expect(pack.text).not.to.include("Reading Crown Court D");
    for (const d of docs) expect(pack.text, `${d.id} missing`).to.include(`[${d.id} p.`);
    // Real content, not a line per document.
    expect(pack.text.length).to.be.greaterThan(21 * 500);
  });
});
