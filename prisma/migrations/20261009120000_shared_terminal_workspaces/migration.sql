-- CreateTable
CREATE TABLE "TerminalWorkspaceSelection" (
    "userId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TerminalWorkspaceSelection_pkey" PRIMARY KEY ("userId","caseId")
);

-- CreateIndex
CREATE INDEX "TerminalWorkspaceSelection_workspaceId_idx" ON "TerminalWorkspaceSelection"("workspaceId");

-- AddForeignKey
ALTER TABLE "TerminalWorkspaceSelection" ADD CONSTRAINT "TerminalWorkspaceSelection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TerminalWorkspaceSelection" ADD CONSTRAINT "TerminalWorkspaceSelection_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TerminalWorkspaceSelection" ADD CONSTRAINT "TerminalWorkspaceSelection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "TerminalWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Carry each person's last-used layout per case over before the shared flag goes away.
INSERT INTO "TerminalWorkspaceSelection" ("userId", "caseId", "workspaceId", "updatedAt")
SELECT DISTINCT ON ("userId", "caseId") "userId", "caseId", "id", "updatedAt"
FROM "TerminalWorkspace"
WHERE "isLastUsed" = true AND "caseId" IS NOT NULL
ORDER BY "userId", "caseId", "updatedAt" DESC;

-- AlterTable
ALTER TABLE "TerminalWorkspace" DROP COLUMN "isLastUsed";
