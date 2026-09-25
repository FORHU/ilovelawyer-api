-- Per-user "Last opened" for Case Portfolio — one row per (case, user), upserted when the user opens
-- a case. Separate from Case.updatedAt, which tracks real activity rather than views.
-- CreateTable
CREATE TABLE "CaseView" (
    "caseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lastOpenedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseView_pkey" PRIMARY KEY ("caseId","userId")
);

-- CreateIndex
CREATE INDEX "CaseView_userId_idx" ON "CaseView"("userId");

-- AddForeignKey
ALTER TABLE "CaseView" ADD CONSTRAINT "CaseView_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseView" ADD CONSTRAINT "CaseView_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
