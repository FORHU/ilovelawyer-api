import heicConvert from "heic-convert";
import sharp from "sharp";

/** How many leading bytes the content check reads: enough for every signature below. */
export const CONTENT_SNIFF_BYTES = 64;

const startsWith = (head: Buffer, bytes: number[], offset = 0) =>
  head.length >= offset + bytes.length && bytes.every((b, i) => head[offset + i] === b);
const ascii = (head: Buffer, start: number, end: number) => head.toString("latin1", start, end);

const HEIF_BRANDS = ["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"];
const MP4_FAMILY_BRANDS = ["isom", "iso2", "mp41", "mp42", "avc1", "dash", "M4V ", "MSNV"];

const isIso = (head: Buffer, brands: string[]) => ascii(head, 4, 8) === "ftyp" && brands.includes(ascii(head, 8, 12));
const isRiff = (head: Buffer, form: string) => ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === form;
const isMp3 = (head: Buffer) =>
  ascii(head, 0, 3) === "ID3" || (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0);

const SIGNATURES: Record<string, (head: Buffer) => boolean> = {
  pdf: (h) => ascii(h, 0, 5) === "%PDF-",
  jpg: (h) => startsWith(h, [0xff, 0xd8, 0xff]),
  jpeg: (h) => startsWith(h, [0xff, 0xd8, 0xff]),
  png: (h) => startsWith(h, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  webp: (h) => isRiff(h, "WEBP"),
  heic: (h) => isIso(h, HEIF_BRANDS),
  wav: (h) => isRiff(h, "WAVE"),
  mp3: isMp3,
  m4a: (h) => isIso(h, [...MP4_FAMILY_BRANDS, "M4A ", "M4B "]),
  mp4: (h) => isIso(h, [...MP4_FAMILY_BRANDS, "M4A ", "qt  "]),
  // OOXML files are zip containers; legacy .doc is an OLE compound file.
  docx: (h) => startsWith(h, [0x50, 0x4b]),
  xlsx: (h) => startsWith(h, [0x50, 0x4b]),
  xlsm: (h) => startsWith(h, [0x50, 0x4b]),
  xlam: (h) => startsWith(h, [0x50, 0x4b]),
  doc: (h) => startsWith(h, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
};

export const extensionOf = (name: string) => name.split(".").pop()?.toLowerCase() ?? "";

/** False when the file's first bytes don't match what its extension claims. Extensions with no
 * reliable signature (plain text) pass: they are checked by being unreadable as anything else. */
export function contentMatchesExtension(filename: string, head: Buffer): boolean {
  const check = SIGNATURES[extensionOf(filename)];
  return check ? check(head) : true;
}

/** Re-encodes a HEIC photo as JPEG, the form browsers can show and Textract can read. */
export async function heicToJpeg(input: Buffer): Promise<Buffer> {
  const out = await heicConvert({ buffer: input, format: "JPEG", quality: 0.9 });
  return Buffer.from(out);
}

/** Re-encodes a WebP image as JPEG for OCR (Textract reads only JPEG and PNG). Transparency is
 * flattened onto white so a transparent screenshot doesn't turn black. */
export async function webpToJpeg(input: Buffer): Promise<Buffer> {
  return sharp(input).flatten({ background: "#ffffff" }).jpeg({ quality: 90 }).toBuffer();
}
