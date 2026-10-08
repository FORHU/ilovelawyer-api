/** Loaded before every spec (package.json "test" --require). SecurityAuditSvc.record runs inside
 * many services the specs exercise with stubbed repos; without this it would reach the real
 * database in .env — and the security audit table is append-only, so a test row could never be
 * cleaned up. Every SecurityAuditRepo method is replaced with an in-memory no-op here; a spec that
 * asserts on audit rows stubs SecurityAuditSvc.record (or these methods) itself, and its usual
 * stash/restore puts these doubles back. */
import SecurityAuditRepo from "../../src/repositories/security-audit.repository";

const repo = SecurityAuditRepo as any;
repo.create = async (data: object) => ({ id: "test-audit-row", createdAt: new Date(), ...data });
repo.findUserAuditInfo = async () => null;
repo.findUserIdByEmail = async () => null;
repo.findOrganizationTenantCode = async () => null;
repo.list = async () => [];
repo.deleteOlderThan = async () => 0;
repo.count = async () => 0;
repo.findNames = async () => {
  const names: Record<string, Map<string, unknown>> = {};
  for (const key of ["users", "organizations", "cases", "documents", "consultations", "transcriptions", "notes", "briefs", "files", "audioOverviews", "messages", "invites", "integrations"]) {
    names[key] = new Map();
  }
  return names;
};
