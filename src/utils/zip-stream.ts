import zlib from "zlib";
import { once } from "events";

/** A small streaming ZIP writer, so a large export never has to sit in memory.
 *
 * Entries are written one at a time, deflated as they arrive, with the sizes and CRC placed after
 * the data (a "data descriptor") because they are not known up front. Limits of the classic ZIP
 * format apply: no single entry, nor the archive as a whole, may reach 4 GB, and there may be at
 * most 65,535 entries. Callers check before adding; exceeding a limit throws. */

const MAX_ENTRY_BYTES = 0xffffffff;
const MAX_ENTRIES = 0xffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(previous: number, chunk: Buffer): number {
  let crc = ~previous >>> 0;
  for (let i = 0; i < chunk.length; i++) crc = CRC_TABLE[(crc ^ chunk[i]!) & 0xff]! ^ (crc >>> 8);
  return ~crc >>> 0;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

interface CentralRecord {
  name: Buffer;
  crc: number;
  compressedSize: number;
  size: number;
  offset: number;
  dosTime: number;
  dosDate: number;
}

export type ZipSink = (chunk: Buffer) => void | Promise<void>;

export class ZipEntry {
  private crc = 0;
  private size = 0;
  private compressedSize = 0;
  private readonly deflater = zlib.createDeflateRaw();
  private readonly drained: Promise<void>;

  constructor(
    private readonly zip: ZipWriter,
    private readonly name: Buffer,
    private readonly offset: number,
    private readonly modified: { time: number; date: number },
  ) {
    this.drained = (async () => {
      for await (const chunk of this.deflater) {
        this.compressedSize += (chunk as Buffer).length;
        await this.zip.emit(chunk as Buffer);
      }
    })();
  }

  /** Appends data to this entry, waiting if the compressor is backed up. */
  async write(data: Buffer | string): Promise<void> {
    const chunk = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    if (chunk.length === 0) return;
    this.size += chunk.length;
    if (this.size > MAX_ENTRY_BYTES) throw new Error(`ZIP entry too large: ${this.name.toString("utf8")}`);
    this.crc = crc32(this.crc, chunk);
    if (!this.deflater.write(chunk)) await once(this.deflater, "drain");
  }

  /** Finishes the entry and writes its data descriptor. */
  async end(): Promise<void> {
    this.deflater.end();
    await this.drained;
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(this.crc, 4);
    descriptor.writeUInt32LE(this.compressedSize, 8);
    descriptor.writeUInt32LE(this.size, 12);
    await this.zip.emit(descriptor);
    this.zip.record({
      name: this.name,
      crc: this.crc,
      compressedSize: this.compressedSize,
      size: this.size,
      offset: this.offset,
      dosTime: this.modified.time,
      dosDate: this.modified.date,
    });
  }
}

export class ZipWriter {
  private offset = 0;
  private readonly records: CentralRecord[] = [];
  private open = false;

  constructor(private readonly sink: ZipSink) {}

  /** @internal */
  async emit(chunk: Buffer): Promise<void> {
    this.offset += chunk.length;
    if (this.offset > MAX_ENTRY_BYTES) throw new Error("ZIP archive too large");
    await this.sink(chunk);
  }

  /** @internal */
  record(entry: CentralRecord): void {
    this.records.push(entry);
    this.open = false;
  }

  get entryCount(): number {
    return this.records.length;
  }

  /** Starts a new entry. The previous one must have been ended. Names use forward slashes. */
  async startEntry(name: string, modified: Date = new Date()): Promise<ZipEntry> {
    if (this.open) throw new Error("Finish the current ZIP entry before starting another");
    if (this.records.length >= MAX_ENTRIES) throw new Error("Too many entries for a ZIP archive");
    this.open = true;

    const nameBytes = Buffer.from(name, "utf8");
    const stamp = dosDateTime(modified);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x0808, 6); // bit 3: data descriptor follows, bit 11: UTF-8 name
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt16LE(stamp.time, 10);
    header.writeUInt16LE(stamp.date, 12);
    header.writeUInt16LE(nameBytes.length, 26);
    const offset = this.offset;
    await this.emit(Buffer.concat([header, nameBytes]));
    return new ZipEntry(this, nameBytes, offset, stamp);
  }

  async addBuffer(name: string, data: Buffer | string): Promise<void> {
    const entry = await this.startEntry(name);
    await entry.write(data);
    await entry.end();
  }

  /** Writes the central directory. Call once, after the last entry. */
  async finish(): Promise<void> {
    const directoryStart = this.offset;
    for (const r of this.records) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4); // version made by
      header.writeUInt16LE(20, 6); // version needed
      header.writeUInt16LE(0x0808, 8);
      header.writeUInt16LE(8, 10);
      header.writeUInt16LE(r.dosTime, 12);
      header.writeUInt16LE(r.dosDate, 14);
      header.writeUInt32LE(r.crc, 16);
      header.writeUInt32LE(r.compressedSize, 20);
      header.writeUInt32LE(r.size, 24);
      header.writeUInt16LE(r.name.length, 28);
      header.writeUInt32LE(r.offset, 42);
      await this.emit(Buffer.concat([header, r.name]));
    }
    const directorySize = this.offset - directoryStart;

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.records.length, 8);
    end.writeUInt16LE(this.records.length, 10);
    end.writeUInt32LE(directorySize, 12);
    end.writeUInt32LE(directoryStart, 16);
    await this.emit(end);
  }
}
