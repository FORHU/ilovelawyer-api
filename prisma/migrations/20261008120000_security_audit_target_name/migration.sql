-- The name a deleted target had, kept so the audit log can still say which document, case or
-- transcription was deleted (SecurityAuditEvent.targetName). Adding a column is not an UPDATE, so
-- the append-only trigger does not apply.
ALTER TABLE "SecurityAuditEvent" ADD COLUMN "targetName" TEXT;
