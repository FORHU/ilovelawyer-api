/** Generated-document renderers — real docx/pdf output (no mocks), checked for the things a user
 * would notice: no case-brief cover/TOC, no leaked markdown, drafter line breaks kept. */
import { expect } from "chai";
import { describe, it } from "mocha";
import { inflateRawSync } from "zlib";
import { renderGeneratedDocx, renderGeneratedPdf } from "../src/utils/generated-document-renderer";

const DRAFT = [
  "```markdown",
  "**REPUBLIC OF THE PHILIPPINES**",
  "QUEZON CITY",
  "",
  "# AFFIDAVIT OF LOSS",
  "",
  "---",
  "",
  "I, **Juan Dela Cruz**, paid ₱1,500 for the license.",
  "",
  "JUAN DELA CRUZ",
  "Affiant",
  "```",
].join("\n");

/** Reads word/document.xml out of a docx (a zip) without a zip dependency: finds the entry's local
 * file header and inflates its deflate stream. */
function docxXml(buffer: Buffer): string {
  const nameAt = buffer.indexOf("word/document.xml");
  const header = nameAt - 30; // local file header is 30 bytes before the file name
  expect(buffer.readUInt32LE(header), "local file header signature").to.equal(0x04034b50);
  const compressedSize = buffer.readUInt32LE(header + 18);
  const dataStart = header + 30 + buffer.readUInt16LE(header + 26) + buffer.readUInt16LE(header + 28);
  return inflateRawSync(buffer.subarray(dataStart, dataStart + compressedSize)).toString("utf8");
}

describe("renderGeneratedDocx", () => {
  it("outputs only the drafted text — no case-brief cover, TOC, code fence or rules", async () => {
    const xml = docxXml(await renderGeneratedDocx(DRAFT));
    for (const noise of ["```", "Action Type", "Jurisdiction:", "Last Refreshed", "TOC", "---"]) {
      expect(xml, noise).to.not.include(noise);
    }
    expect(xml).to.include("AFFIDAVIT OF LOSS");
    expect(xml).to.include("₱1,500");
  });

  it("keeps single-newline lines (signature block) as line breaks within one paragraph", async () => {
    const xml = docxXml(await renderGeneratedDocx(DRAFT));
    const signature = xml.split("</w:p>").find((p) => p.includes("JUAN DELA CRUZ"))!;
    expect(signature).to.include("<w:br/>");
    expect(signature).to.include("Affiant");
  });

  it("renders **bold** spans as bold runs", async () => {
    const xml = docxXml(await renderGeneratedDocx(DRAFT));
    const paragraph = xml.split("</w:p>").find((p) => p.includes("Juan Dela Cruz"))!;
    expect(paragraph).to.match(/<w:b\/>[^]*Juan Dela Cruz/);
    expect(paragraph).to.not.include("**");
  });
});

describe("renderGeneratedPdf", () => {
  it("produces a PDF", async () => {
    const buffer = await renderGeneratedPdf(DRAFT);
    expect(buffer.subarray(0, 5).toString()).to.equal("%PDF-");
  });

  it("does not throw on long multi-page content (footer/pagination recursion guard)", async () => {
    const long = Array.from({ length: 200 }, (_, i) => `Paragraph ${i + 1}. ${"Lorem ipsum ".repeat(30)}`).join("\n\n");
    const buffer = await renderGeneratedPdf(long);
    expect(buffer.length).to.be.greaterThan(1000);
  });
});
