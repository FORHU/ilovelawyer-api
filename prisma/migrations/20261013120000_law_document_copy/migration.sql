-- CreateTable
CREATE TABLE "LawDocumentCopy" (
    "id" TEXT NOT NULL,
    "lawId" TEXT NOT NULL,
    "part" TEXT NOT NULL DEFAULT '',
    "format" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LawDocumentCopy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LawDocumentCopy_lawId_part_checkedAt_idx" ON "LawDocumentCopy"("lawId", "part", "checkedAt");

-- AddForeignKey
ALTER TABLE "LawDocumentCopy" ADD CONSTRAINT "LawDocumentCopy_lawId_fkey" FOREIGN KEY ("lawId") REFERENCES "Law"("id") ON DELETE CASCADE ON UPDATE CASCADE;
