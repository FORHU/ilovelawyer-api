-- AiGenerationJob.heartbeatAt: stamped while a job's work runs, so a run lost to a restart is
-- recognised by its silence rather than by its age. Existing rows start as NULL.
ALTER TABLE "AiGenerationJob" ADD COLUMN "heartbeatAt" TIMESTAMP(3);
