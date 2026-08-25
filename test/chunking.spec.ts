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
  it("produces one chunk per paragraph regardless of tier", () => {
    const pages = Array.from({ length: 1000 }, (_, i) => ({
      pageNumber: i + 1,
      text: "Whereas the parties agree.\n\n".repeat(80),
    }));
    const chunks = chunkPages(pages);
    expect(chunks.length).to.equal(1000 * 80);
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
