import prisma from "../lib/prisma";
import { Prisma } from "@prisma/client";

type DbClient = Prisma.TransactionClient | typeof prisma;

export default class FilesRepo {
  static async create(filename: string, fileUrl: string, s3Key: string, metaData?: Prisma.InputJsonValue) {
    return prisma.file.create({ data: { filename, fileUrl, s3Key, metaData } });
  }

  static async createFile(payload: Express.FileTypes[], client: DbClient = prisma) {
    return client.file.createManyAndReturn({ data: payload });
  }

  /** Flags a File FOR_DELETION once nothing points at it any more — a File can in principle be
   * referenced by more than one Document (see File.caseDocuments), so this only flips the flag
   * when the count truly hits zero. Marking (not deleting outright) leaves the actual S3 object
   * removal to a separate sweep job, same as `deletedAt`'s existing soft-delete convention on
   * this model — this repo has no opinion on when/how that sweep runs. */
  /** Same soft-delete convention as markForDeletionIfOrphaned, for a File with a single owner
   * (a replaced or removed avatar): the S3 object is left to the sweep job. */
  static async markForDeletion(fileId: string): Promise<void> {
    await prisma.file.update({ where: { id: fileId }, data: { fileStatus: "FOR_DELETION", deletedAt: new Date() } });
  }

  static async markForDeletionIfOrphaned(fileId: string): Promise<void> {
    const stillReferenced = await prisma.document.findFirst({ where: { fileId }, select: { id: true } });
    if (stillReferenced) return;
    await prisma.file.update({ where: { id: fileId }, data: { fileStatus: "FOR_DELETION" } });
  }
}
