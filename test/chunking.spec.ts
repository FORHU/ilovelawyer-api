import { expect } from "chai";
import { describe, it } from "mocha";
import {
  chunkPages,
  chunkText,
  resolveChunkingProfile,
} from "../src/utils/chunking";

describe("resolveChunkingProfile", () => {
  it("uses compact chunks for a short pleading", () => {
    const profile = resolveChunkingProfile({
      pageCount: 2,
      totalChars: 3_000,
      fileSizeBytes: 80_000,
    });
    expect(profile.tier).to.equal("compact");
    expect(profile.chunkSize).to.equal(1_200);
  });

  it("keeps the previous default for a typical motion", () => {
    const profile = resolveChunkingProfile({
      pageCount: 20,
      totalChars: 40_000,
      fileSizeBytes: 1_000_000,
    });
    expect(profile.tier).to.equal("default");
    expect(profile.chunkSize).to.equal(2_000);
  });

  it("widens chunks for a long brief", () => {
    const profile = resolveChunkingProfile({
      pageCount: 80,
      totalChars: 150_000,
      fileSizeBytes: 4_000_000,
    });
    expect(profile.tier).to.equal("large");
    expect(profile.chunkSize).to.equal(4_000);
    expect(profile.embeddingBatchSize).to.equal(50);
  });

  it("uses bulk chunks for a 1000-page PDF", () => {
    const profile = resolveChunkingProfile({
      pageCount: 1000,
      totalChars: 2_000_000,
      fileSizeBytes: 40 * 1024 * 1024,
    });
    expect(profile.tier).to.equal("bulk");
    expect(profile.chunkSize).to.equal(6_000);
    expect(profile.embeddingBatchSize).to.equal(32);
  });
});

describe("chunkText", () => {
  it("does not drop an oversize paragraph", () => {
    const text = "a".repeat(5_000);
    const chunks = chunkText(text, 1, { chunkSize: 2_000, overlap: 300 });
    expect(chunks.length).to.be.greaterThan(1);
    expect(chunks.every((c) => c.text.length <= 2_000)).to.equal(true);
  });

  it("packs lines into chunks of up to chunkSize when there are no blank lines, losing none", () => {
    const lines = Array.from({ length: 1_000 }, (_, i) => `Line ${i}: the respondent failed to pay wages.`);
    const text = lines.join("\n");
    const chunks = chunkText(text, 1, { chunkSize: 2_000, overlap: 300 });

    // Each chunk stops at a line boundary, so it may fall up to one line (< 60 chars) short of 2,000.
    expect(chunks.length).to.be.within(Math.ceil(text.length / 2_000), Math.ceil(text.length / (2_000 - 60)));
    expect(chunks.every((c) => c.text.length <= 2_000)).to.equal(true);
    expect(chunks.flatMap((c) => c.text.split("\n"))).to.deep.equal(lines);
  });

  it("still hard-cuts one over-long line among packed lines", () => {
    const text = ["short", "x".repeat(5_000), "after"].join("\n");
    const chunks = chunkText(text, 1, { chunkSize: 2_000, overlap: 300 });
    expect(chunks.every((c) => c.text.length <= 2_000)).to.equal(true);
    expect(chunks[0].text).to.equal("short");
    expect(chunks.at(-1)!.text).to.equal("after");
  });

  it("makes each paragraph its own chunk", () => {
    const text = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
    const chunks = chunkText(text, 1, { chunkSize: 2_000, overlap: 300 });
    expect(chunks.map((c) => c.text)).to.deep.equal([
      "First paragraph.",
      "Second paragraph.",
      "Third paragraph.",
    ]);
  });
});

describe("chunkPages", () => {
  it("keeps one chunk per paragraph below the bulk tier", () => {
    const pages = Array.from({ length: 30 }, (_, i) => ({
      pageNumber: i + 1,
      text: "Whereas the parties agree.\n\n".repeat(20),
    }));
    const chunks = chunkPages(pages); // 30 pages, ~16k chars: default tier
    expect(chunks.length).to.equal(30 * 20);
    expect(chunks.every((c) => c.text === "Whereas the parties agree.")).to.equal(true);
  });

  it("packs paragraphs per page up to chunkSize at the bulk tier, losing none and never crossing pages", () => {
    const pages = Array.from({ length: 1000 }, (_, i) => ({
      pageNumber: i + 1,
      text: Array.from({ length: 80 }, (_, j) => `Paragraph ${j} of page ${i + 1}: whereas the parties agree.`).join("\n\n"),
    }));
    const chunks = chunkPages(pages); // 1000 pages: bulk tier, chunkSize 6,000
    expect(chunks.length).to.equal(1000); // each page's ~4,300 chars fit one chunk
    expect(chunks.every((c) => c.text.length <= 6_000)).to.equal(true);
    expect(chunks.map((c) => c.pageNumber)).to.deep.equal(pages.map((p) => p.pageNumber));
    expect(chunks[0].text.split("\n\n")).to.deep.equal(pages[0].text.split("\n\n"));
  });

  it("splits a bulk-tier page's paragraphs across chunks when they exceed chunkSize", () => {
    const paragraph = "x".repeat(1_000);
    const page = { pageNumber: 1, text: Array.from({ length: 20 }, () => paragraph).join("\n\n") };
    const chunks = chunkPages([page], { chunkSize: 6_000, overlap: 500, packParagraphs: true });
    // 5 paragraphs + 4 separators = 5,008 chars; a 6th would pass 6,000.
    expect(chunks.map((c) => c.text.split("\n\n").length)).to.deep.equal([5, 5, 5, 5]);
  });

  it("still hard-cuts an oversize paragraph, and a wider tier cuts it less", () => {
    const pages = Array.from({ length: 1000 }, (_, i) => ({
      pageNumber: i + 1,
      text: "a".repeat(5_000),
    }));
    const adaptive = chunkPages(pages); // bulk tier: chunkSize 6_000, paragraph fits whole
    const tight = chunkPages(pages, { chunkSize: 2_000, overlap: 300 });
    expect(adaptive.length).to.equal(1000);
    expect(adaptive.length).to.be.lessThan(tight.length);
  });
});
