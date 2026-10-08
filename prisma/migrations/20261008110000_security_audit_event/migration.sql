-- The security audit log (docs/adr/0006-security-audit-log.md). Its own table, apart from
-- AuditEvent (the case activity feed that also drives mind map / Case Strategy staleness).
CREATE TYPE "SecurityAuditOutcome" AS ENUM ('SUCCESS', 'FAILURE');

CREATE TABLE "SecurityAuditEvent" (
    "id"             TEXT NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action"         TEXT NOT NULL,
    "outcome"        "SecurityAuditOutcome" NOT NULL DEFAULT 'SUCCESS',
    "organizationId" TEXT,
    "tenantCode"     TEXT,
    "actorId"        TEXT,
    "actorEmail"     TEXT,
    "targetType"     TEXT,
    "targetId"       TEXT,
    "caseId"         TEXT,
    "ip"             TEXT,
    "userAgent"      TEXT,
    "requestId"      TEXT,
    "payload"        JSONB,

    CONSTRAINT "SecurityAuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SecurityAuditEvent_organizationId_createdAt_idx" ON "SecurityAuditEvent"("organizationId", "createdAt");
CREATE INDEX "SecurityAuditEvent_actorId_createdAt_idx" ON "SecurityAuditEvent"("actorId", "createdAt");
CREATE INDEX "SecurityAuditEvent_caseId_idx" ON "SecurityAuditEvent"("caseId");
CREATE INDEX "SecurityAuditEvent_createdAt_idx" ON "SecurityAuditEvent"("createdAt");

-- Append-only, enforced by the database rather than by convention: a row can't be edited, the
-- table can't be truncated, and a row can only be deleted once it is older than the 365-day
-- retention floor (SecurityAuditRetentionQueue's sweep; SECURITY_AUDIT_RETENTION_DAYS can only
-- keep rows longer than this, never shorter). No foreign keys, so deleting a user, case or
-- organization never touches these rows either.
CREATE FUNCTION "security_audit_event_guard"() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'SecurityAuditEvent is append-only: UPDATE is not allowed';
    END IF;
    IF OLD."createdAt" > (now() AT TIME ZONE 'UTC') - INTERVAL '365 days' THEN
        RAISE EXCEPTION 'SecurityAuditEvent is append-only: rows younger than 365 days cannot be deleted';
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SecurityAuditEvent_append_only"
    BEFORE UPDATE OR DELETE ON "SecurityAuditEvent"
    FOR EACH ROW EXECUTE FUNCTION "security_audit_event_guard"();

CREATE FUNCTION "security_audit_event_no_truncate"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'SecurityAuditEvent is append-only: TRUNCATE is not allowed';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SecurityAuditEvent_no_truncate"
    BEFORE TRUNCATE ON "SecurityAuditEvent"
    FOR EACH STATEMENT EXECUTE FUNCTION "security_audit_event_no_truncate"();

-- Admin and tenant-setting events used to be written to AuditEvent with no caseId, where nothing
-- could read them. Copy them across under their new action names; the AuditEvent rows are left
-- as they were. The target user's org is not known for these old rows, so organizationId stays
-- null (platform admins still see them).
INSERT INTO "SecurityAuditEvent" ("id", "createdAt", "action", "actorId", "actorEmail", "targetType", "targetId", "payload")
SELECT
    a."id",
    a."createdAt",
    CASE a."action"
        WHEN 'users.email_verified' THEN 'admin.user.email_verified'
        WHEN 'users.tenant_changed' THEN 'admin.user.tenant_changed'
        WHEN 'users.deleted' THEN 'admin.user.deleted'
        WHEN 'users.bulk_approved' THEN 'admin.user.approved'
        WHEN 'settings.signup_auto_approve.changed' THEN 'admin.settings.signup_auto_approve_changed'
    END,
    a."actorId",
    u."email",
    CASE WHEN a."action" IN ('users.bulk_approved', 'settings.signup_auto_approve.changed') THEN 'tenant' ELSE 'user' END,
    COALESCE(a."payload"->>'userId', a."payload"->>'tenant'),
    a."payload"
FROM "AuditEvent" a
LEFT JOIN "User" u ON u."id" = a."actorId"
WHERE a."caseId" IS NULL
  AND a."action" IN ('users.email_verified', 'users.tenant_changed', 'users.deleted', 'users.bulk_approved', 'settings.signup_auto_approve.changed');
