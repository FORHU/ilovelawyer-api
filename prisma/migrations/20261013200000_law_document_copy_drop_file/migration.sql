-- Law document copies no longer link to File: every copy keeps its own bytes in "content".
-- The copies saved before 20261013190000 held no content, only a link to an S3-backed File, so they
-- are removed here. Their File rows and S3 objects are left in place.
DELETE FROM "LawDocumentCopy" WHERE "content" IS NULL;

-- DropForeignKey
ALTER TABLE "LawDocumentCopy" DROP CONSTRAINT "LawDocumentCopy_fileId_fkey";

-- AlterTable
ALTER TABLE "LawDocumentCopy" DROP COLUMN "fileId",
ALTER COLUMN "content" SET NOT NULL,
ALTER COLUMN "bytes" SET NOT NULL;
