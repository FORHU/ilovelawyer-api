import prisma from "../lib/prisma";
import { deleteS3Object } from "../utils/s3";
import logger from "../utils/logger";

/** Files fetched per round. */
const BATCH = 100;

/** A File nothing points at any more: none of the eight relations that can hold one. A relation
 * left out here could have its link nulled when the row is deleted, so every one is checked. */
const UNREFERENCED = {
  fileStatus: "FOR_DELETION",
  users: { none: {} },
  transcriptions: { none: {} },
  caseDocuments: { none: {} },
  caseReconstructionAudio: { none: {} },
  caseReconstructionTableRead: { none: {} },
  audioOverviews: { none: {} },
  caseBriefExports: { none: {} },
  generatedDocuments: { none: {} },
} as const;

/**
 * The sweep that every delete in the app leaves files to: deletions only mark a File FOR_DELETION
 * (FileRepo, OrganizationRepo.deletePermanently, ChatRepo...); this removes each one that nothing
 * references any more — its S3 object first, then its row. A file whose S3 key another live File
 * still uses keeps its object. Run by FileCleanupQueue.
 */
export default class FileCleanupSvc {
  /** Overridable in tests, which have no S3. */
  static deleteObject: (key: string) => Promise<void> = deleteS3Object;

  /** Returns how many files were removed. */
  static async sweep(): Promise<number> {
    let removed = 0;
    let afterId: string | undefined;
    for (;;) {
      const files = await prisma.file.findMany({
        where: { ...UNREFERENCED, ...(afterId ? { id: { gt: afterId } } : {}) },
        select: { id: true, s3Key: true },
        orderBy: { id: "asc" },
        take: BATCH,
      });
      if (!files.length) break;
      afterId = files[files.length - 1].id;

      for (const file of files) {
        try {
          if (file.s3Key) {
            const sharedWithLiveFile = await prisma.file.findFirst({
              where: { s3Key: file.s3Key, id: { not: file.id }, NOT: { fileStatus: "FOR_DELETION" } },
              select: { id: true },
            });
            if (!sharedWithLiveFile) await FileCleanupSvc.deleteObject(file.s3Key);
          }
          // Same conditions again: a file re-linked since it was read is left alone.
          const { count } = await prisma.file.deleteMany({ where: { id: file.id, ...UNREFERENCED } });
          removed += count;
        } catch (err) {
          logger.error("File cleanup: could not remove a file", { fileId: file.id, err });
        }
      }
    }
    return removed;
  }
}
