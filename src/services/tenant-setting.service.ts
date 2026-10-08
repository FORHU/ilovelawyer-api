import AuthRepo from "../repositories/auth.repository";
import SecurityAuditSvc from "./security-audit.service";
import TenantRepo from "../repositories/tenant.repository";
import TenantSettingRepo from "../repositories/tenant-setting.repository";
import BulkApprovalRunner from "../queues/bulk-approval.runner";
import HttpError from "../utils/http-error";
import { redis } from "../lib/redis";
import { asTenantCode, type TenantCode } from "../types/tenant-code";
import { TENANT_SETTING_KEYS, TENANT_SETTINGS_CACHE_TTL_S } from "../constants";

const autoApproveCacheKey = (tenantId: string) => `tenant-settings:${tenantId}:${TENANT_SETTING_KEYS.signupAutoApprove}`;

export default class TenantSettingSvc {
  /** Whether signups under this Tenant skip manual approval. Off by default (no row), and
   * always off for a user with no Tenant — nothing to look the switch up on, so they wait
   * for an admin like before. Read on every signup/verification, hence the cache. */
  static async isAutoApproveOn(tenantId: string | null): Promise<boolean> {
    if (!tenantId) return false;

    const cacheKey = autoApproveCacheKey(tenantId);
    const cached = await redis.get<boolean>(cacheKey);
    if (cached !== null) return cached;

    const row = await TenantSettingRepo.find(tenantId, TENANT_SETTING_KEYS.signupAutoApprove);
    const enabled = row?.value === true;
    await redis.set(cacheKey, enabled, TENANT_SETTINGS_CACHE_TTL_S);
    return enabled;
  }

  /** The admin Settings page: one entry per Tenant with its switch, pending backlog and any
   * in-flight/recent "Approve all pending" run. Deliberately uncached — the page polls this
   * while a run is going and needs live counts. */
  static async listForAdmin() {
    const [tenants, rows] = await Promise.all([
      TenantRepo.listAll(),
      TenantSettingRepo.findAllForKey(TENANT_SETTING_KEYS.signupAutoApprove),
    ]);

    return Promise.all(
      tenants.map(async (tenant) => {
        const row = rows.find((r) => r.tenantId === tenant.id);
        const code = asTenantCode(tenant.code);
        const [pendingCount, bulkApproval] = await Promise.all([
          AuthRepo.countApprovablePending(tenant.id),
          BulkApprovalRunner.getProgress(code),
        ]);
        return {
          code,
          name: tenant.name,
          autoApproveSignups: row?.value === true,
          updatedAt: row?.updatedAt ?? null,
          updatedBy: row?.updatedBy ?? null,
          pendingCount,
          bulkApproval,
        };
      }),
    );
  }

  static async setAutoApprove(code: TenantCode, enabled: boolean, adminId: string) {
    const tenant = await TenantRepo.findByCode(code);
    if (!tenant) throw new HttpError(`Unknown tenant ${code}`, 404);

    const before = await TenantSettingRepo.find(tenant.id, TENANT_SETTING_KEYS.signupAutoApprove);
    await TenantSettingRepo.upsert(tenant.id, TENANT_SETTING_KEYS.signupAutoApprove, enabled, adminId);
    await redis.del(autoApproveCacheKey(tenant.id));

    await SecurityAuditSvc.record({
      action: "admin.settings.signup_auto_approve_changed",
      actorId: adminId,
      organizationId: null,
      targetType: "tenant",
      targetId: code,
      payload: { from: before?.value === true, to: enabled },
    });

    const all = await TenantSettingSvc.listForAdmin();
    return all.find((t) => t.code === code)!;
  }
}
