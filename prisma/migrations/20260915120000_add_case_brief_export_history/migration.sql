-- Case Brief export history — one row per generation (preview or download alike), so a lawyer
-- can see and redownload past Case Brief renders instead of only ever having the most recent one.
-- CreateTable
CREATE TABLE "CaseBriefExport" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseBriefExport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CaseBriefExport_caseId_idx" ON "CaseBriefExport"("caseId");

-- AddForeignKey
ALTER TABLE "CaseBriefExport" ADD CONSTRAINT "CaseBriefExport_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseBriefExport" ADD CONSTRAINT "CaseBriefExport_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseBriefExport" ADD CONSTRAINT "CaseBriefExport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
