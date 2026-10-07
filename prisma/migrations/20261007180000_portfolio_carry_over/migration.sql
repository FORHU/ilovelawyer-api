-- Portfolio copies of standalone consultations (ones not on a case) a member started in an
-- organization they've left, worked through by CaseCopyQueue alongside CaseCopy.
CREATE TABLE "ConsultationCopy" (
    "id"                   TEXT NOT NULL,
    "sourceConsultationId" TEXT NOT NULL,
    "userId"               TEXT NOT NULL,
    "targetOrganizationId" TEXT NOT NULL,
    "status"               "CaseCopyStatus" NOT NULL DEFAULT 'PENDING',
    "copyConsultationId"   TEXT,
    "attempts"             INTEGER NOT NULL DEFAULT 0,
    "error"                TEXT,
    "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConsultationCopy_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ConsultationCopy_userId_status_idx" ON "ConsultationCopy"("userId", "status");
CREATE INDEX "ConsultationCopy_status_updatedAt_idx" ON "ConsultationCopy"("status", "updatedAt");

ALTER TABLE "ConsultationCopy" ADD CONSTRAINT "ConsultationCopy_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConsultationCopy" ADD CONSTRAINT "ConsultationCopy_targetOrganizationId_fkey"
    FOREIGN KEY ("targetOrganizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
