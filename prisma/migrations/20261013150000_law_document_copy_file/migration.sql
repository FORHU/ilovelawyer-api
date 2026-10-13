-- Each saved law copy's S3 object becomes a row in the central "File" table; "LawDocumentCopy" keeps a
-- "fileId" instead of its own s3Key/contentType/bytes. Existing copies are moved over, not dropped: each
-- gets a File with the same id, named after its legislation.gov.uk path (e.g. "ukpga-2018-12.html").

-- AlterTable
ALTER TABLE "LawDocumentCopy" ADD COLUMN "fileId" TEXT;

-- Move existing copies into File
INSERT INTO "File" ("id", "filename", "s3Key", "metaData", "createdAt", "updatedAt", "fileStatus")
SELECT
    c."id",
    COALESCE(
        replace(substring(c."sourceUrl" from 'legislation\.gov\.uk/(.+)/data\.[a-z]+$'), '/', '-'),
        'law-document'
    ) || '.' || c."format",
    c."s3Key",
    jsonb_build_object('contentType', c."contentType", 'bytes', c."bytes", 'sha256', c."sha256"),
    c."fetchedAt",
    c."checkedAt",
    'ACTIVE'
FROM "LawDocumentCopy" c;

UPDATE "LawDocumentCopy" SET "fileId" = "id";

-- AlterTable
ALTER TABLE "LawDocumentCopy" ALTER COLUMN "fileId" SET NOT NULL,
DROP COLUMN "bytes",
DROP COLUMN "contentType",
DROP COLUMN "s3Key";

-- AddForeignKey
ALTER TABLE "LawDocumentCopy" ADD CONSTRAINT "LawDocumentCopy_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
