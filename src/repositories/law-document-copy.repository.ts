import prisma from "../lib/prisma";
import { Prisma } from "@prisma/client";

/** Every column but `content` — lookups never load a document's bytes. */
const meta = {
  id: true,
  lawId: true,
  part: true,
  sha256: true,
  sourceUrl: true,
  bytes: true,
  fetchedAt: true,
  checkedAt: true,
} as const;

export type LawDocumentCopyMeta = Prisma.LawDocumentCopyGetPayload<{ select: typeof meta }>;

/** Copies of law documents, kept in Postgres — see LawDocumentSvc. Rows are never deleted here: a
 * changed document adds a row, so older versions stay on record. */
export default class LawDocumentCopyRepo {
  /** The most recently confirmed copy of one part ("" = whole document, "section/29"), without its bytes. */
  static async findLatest(lawId: string, part: string): Promise<LawDocumentCopyMeta | null> {
    return prisma.lawDocumentCopy.findFirst({ where: { lawId, part }, orderBy: { checkedAt: "desc" }, select: meta });
  }

  /** One copy's gzip-compressed bytes. */
  static async findContent(id: string): Promise<Buffer | null> {
    const row = await prisma.lawDocumentCopy.findUnique({ where: { id }, select: { content: true } });
    return row ? Buffer.from(row.content) : null;
  }

  static async create(data: Prisma.LawDocumentCopyUncheckedCreateInput) {
    return prisma.lawDocumentCopy.create({ data, select: { id: true } });
  }

  /** legislation.gov.uk served the same bytes again. */
  static async markChecked(id: string, checkedAt: Date) {
    return prisma.lawDocumentCopy.update({ where: { id }, data: { checkedAt }, select: { id: true } });
  }
}
