-- Law document copies keep their bytes in Postgres (gzip-compressed "content") instead of S3. Existing
-- S3-backed copies keep their "fileId" and are left as they are; new copies have no File.

-- AlterTable
ALTER TABLE "LawDocumentCopy" ADD COLUMN     "bytes" INTEGER,
ADD COLUMN     "content" BYTEA,
ALTER COLUMN "fileId" DROP NOT NULL;

