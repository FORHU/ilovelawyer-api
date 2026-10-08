/** ZipWriter — checked by reading its output back with an independent zip reader (jszip), which
 * also verifies every entry's CRC. */
import crypto from "crypto";
import { expect } from "chai";
import { describe, it } from "mocha";
import JSZip from "jszip";
import { ZipWriter } from "../src/utils/zip-stream";

async function build(fill: (zip: ZipWriter) => Promise<void>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const zip = new ZipWriter((chunk) => {
    chunks.push(chunk);
  });
  await fill(zip);
  await zip.finish();
  return Buffer.concat(chunks);
}

describe("ZipWriter", () => {
  it("round-trips text, binary and empty entries with valid CRCs", async () => {
    const binary = crypto.randomBytes(200_000);
    const archive = await build(async (zip) => {
      await zip.addBuffer("data.json", '{"hello":"world"}');
      await zip.addBuffer("files/blob.bin", binary);
      await zip.addBuffer("files/empty.txt", "");
    });

    const read = await JSZip.loadAsync(archive, { checkCRC32: true });
    expect(Object.keys(read.files).sort()).to.deep.equal(["data.json", "files/blob.bin", "files/empty.txt"]);
    expect(await read.file("data.json")!.async("string")).to.equal('{"hello":"world"}');
    expect(Buffer.compare(await read.file("files/blob.bin")!.async("nodebuffer"), binary)).to.equal(0);
    expect(await read.file("files/empty.txt")!.async("string")).to.equal("");
  });

  it("streams an entry in many chunks and compresses repetitive data", async () => {
    const line = "the same line again and again\n";
    let archive = Buffer.alloc(0);
    const chunks: Buffer[] = [];
    const zip = new ZipWriter((c) => {
      chunks.push(c);
    });
    const entry = await zip.startEntry("big.txt");
    for (let i = 0; i < 20_000; i++) await entry.write(line);
    await entry.end();
    await zip.finish();
    archive = Buffer.concat(chunks);

    const read = await JSZip.loadAsync(archive, { checkCRC32: true });
    expect((await read.file("big.txt")!.async("string")).length).to.equal(line.length * 20_000);
    expect(archive.length).to.be.lessThan(line.length * 20_000 * 0.1);
  });

  it("keeps non-ASCII names intact", async () => {
    const archive = await build(async (zip) => zip.addBuffer("files/résumé – 日本語.txt", "ok"));
    const read = await JSZip.loadAsync(archive);
    expect(Object.keys(read.files)).to.deep.equal(["files/résumé – 日本語.txt"]);
  });

  it("refuses to start a second entry before the first is finished", async () => {
    const zip = new ZipWriter(() => undefined);
    await zip.startEntry("a.txt");
    let message = "";
    try {
      await zip.startEntry("b.txt");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).to.include("Finish the current ZIP entry");
  });

  it("waits for a slow sink instead of buffering everything", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const zip = new ZipWriter(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
    });
    await zip.addBuffer("x.bin", crypto.randomBytes(300_000));
    await zip.finish();
    expect(maxInFlight).to.equal(1);
  });
});
