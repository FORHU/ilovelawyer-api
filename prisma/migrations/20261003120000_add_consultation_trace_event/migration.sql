-- CreateTable
CREATE TABLE "ConsultationTraceEvent" (
    "seq" SERIAL NOT NULL,
    "consultationId" TEXT NOT NULL,
    "caseId" TEXT,
    "organizationId" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "userId" TEXT,
    "sessionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsultationTraceEvent_pkey" PRIMARY KEY ("seq")
);

-- CreateIndex
CREATE INDEX "ConsultationTraceEvent_consultationId_seq_idx" ON "ConsultationTraceEvent"("consultationId", "seq");

-- CreateIndex
CREATE INDEX "ConsultationTraceEvent_caseId_turnId_seq_idx" ON "ConsultationTraceEvent"("caseId", "turnId", "seq");

-- CreateIndex
CREATE INDEX "ConsultationTraceEvent_caseId_createdAt_idx" ON "ConsultationTraceEvent"("caseId", "createdAt");

-- CreateIndex
CREATE INDEX "ConsultationTraceEvent_userId_idx" ON "ConsultationTraceEvent"("userId");

-- AddForeignKey
ALTER TABLE "ConsultationTraceEvent" ADD CONSTRAINT "ConsultationTraceEvent_consultationId_fkey" FOREIGN KEY ("consultationId") REFERENCES "Consultation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsultationTraceEvent" ADD CONSTRAINT "ConsultationTraceEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

