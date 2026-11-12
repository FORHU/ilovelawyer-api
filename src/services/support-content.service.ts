import { isDeepStrictEqual } from "util";
import { Prisma } from "@prisma/client";
import SupportContentRepo from "../repositories/support-content.repository";
import SecurityAuditSvc from "./security-audit.service";
import { validateSupportContent } from "./support-content-validator";
import { SUPPORT_CONTENT_V1 } from "../constants/support-content-seed";
import prisma from "../lib/prisma";
import { actionsFor, SUPPORT_ACTION_KEYS, SUPPORT_ACTIONS, type SupportAudience } from "../constants/support-actions.constants";
import HttpError from "../utils/http-error";
import type { PublishedSupportContent, SupportContent, SupportContentProblem, SupportFlow } from "../types/support-content";

function isUniqueViolation(err: unknown) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

const asJson = (content: SupportContent) => content as unknown as Prisma.InputJsonValue;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

async function actorOf(id: string | null | undefined) {
  if (!id) return null;
  const user = (await SupportContentRepo.userNames([id])).get(id);
  return user ? { id: user.id, name: user.name ?? user.email } : { id: id, name: null };
}

/**
 * The Support Chat's content (EPIC ilovelawyer-client#120): admins edit one draft, Publish snapshots
 * it as an immutable version, and clients only ever read the latest version. Rolling back publishes
 * a copy of an earlier version as a new one, so the history stays linear. Version 1 is the bundled
 * seed, published the first time anything reads the content.
 */
export default class SupportContentSvc {
  /** The latest published content, seeding version 1 on a fresh database. */
  static async latestVersion() {
    const latest = await SupportContentRepo.findLatestVersion();
    if (latest) return latest;
    try {
      return await SupportContentRepo.createVersion({ version: 1, content: asJson(SUPPORT_CONTENT_V1), publishedById: null });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      return (await SupportContentRepo.findLatestVersion()) as NonNullable<Awaited<ReturnType<typeof SupportContentRepo.findLatestVersion>>>;
    }
  }

  static async ensureSeeded() {
    await SupportContentSvc.latestVersion();
  }

  /** What a client sees: the enabled menu cards and only the flows available to their audience. */
  static async getPublished(audience: SupportAudience): Promise<PublishedSupportContent> {
    const latest = await SupportContentSvc.latestVersion();
    const content = latest.content as unknown as SupportContent;
    const flows: Record<string, SupportFlow> = {};
    for (const [id, flow] of Object.entries(content.flows)) {
      if (flow.audience === "BOTH" || flow.audience === audience) flows[id] = flow;
    }
    return {
      version: latest.version,
      publishedAt: latest.publishedAt,
      settings: content.settings,
      menu: content.menus[audience].filter((card) => card.enabled && flows[card.flowId]),
      flows,
      actions: actionsFor(audience).map(({ key, label, safetyCopy }) => ({ key, label, ...(safetyCopy ? { safetyCopy } : {}) })),
    };
  }

  static listActions() {
    return SUPPORT_ACTION_KEYS.map((key) => SUPPORT_ACTIONS[key]);
  }

  static async getDraft() {
    const latest = await SupportContentSvc.latestVersion();
    const draft = (await SupportContentRepo.findDraft()) ?? (await SupportContentRepo.createDraft(latest.content as Prisma.InputJsonValue, latest.version, null));
    return {
      content: draft.content as unknown as SupportContent,
      updatedAt: draft.updatedAt,
      updatedBy: await actorOf(draft.updatedById),
      basedOnVersion: draft.basedOnVersion,
      currentVersion: latest.version,
      hasUnpublishedChanges: !isDeepStrictEqual(draft.content, latest.content),
    };
  }

  static async updateDraft(content: SupportContent, expectedUpdatedAt: string, adminId: string) {
    await SupportContentSvc.getDraft();
    const saved = await SupportContentRepo.updateDraftIfUnchanged(new Date(expectedUpdatedAt), asJson(content), adminId);
    if (!saved) {
      throw new HttpError("Someone else changed the draft. Reload it to see their changes.", 409, "DRAFT_CONFLICT");
    }
    await SecurityAuditSvc.record({
      action: "admin.support_content.draft_updated",
      actorId: adminId,
      organizationId: null,
      targetType: "support_content",
      targetId: "draft",
      payload: { flows: Object.keys(content.flows).length },
    });
    return SupportContentSvc.getDraft();
  }

  static async validateDraft(): Promise<{ valid: boolean; problems: SupportContentProblem[] }> {
    const { content } = await SupportContentSvc.getDraft();
    const problems = validateSupportContent(content);
    return { valid: problems.length === 0, problems };
  }

  static async publish(adminId: string) {
    const { content, hasUnpublishedChanges } = await SupportContentSvc.getDraft();
    const problems = validateSupportContent(content);
    if (problems.length > 0) {
      throw new HttpError("The draft has problems. Fix them before publishing.", 422, "SUPPORT_CONTENT_INVALID", { problems });
    }
    if (!hasUnpublishedChanges) throw new HttpError("The draft is the same as the published version.", 409, "NO_CHANGES");

    let created;
    try {
      created = await prisma.$transaction(async (tx) => {
        const latest = await SupportContentRepo.findLatestVersion(tx);
        const version = (latest?.version ?? 0) + 1;
        const row = await SupportContentRepo.createVersion({ version, content: asJson(clone(content)), publishedById: adminId }, tx);
        await SupportContentRepo.resetDraft(asJson(clone(content)), version, adminId, tx);
        return row;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError("Another publish just happened. Reload and try again.", 409, "PUBLISH_CONFLICT");
      throw err;
    }
    await SecurityAuditSvc.record({
      action: "admin.support_content.published",
      actorId: adminId,
      organizationId: null,
      targetType: "support_content",
      targetId: String(created.version),
      payload: { version: created.version },
    });
    return { version: created.version, publishedAt: created.publishedAt };
  }

  static async listVersions() {
    const [rows, latest] = await Promise.all([SupportContentRepo.listVersions(), SupportContentSvc.latestVersion()]);
    const names = await SupportContentRepo.userNames([...new Set(rows.map((r) => r.publishedById).filter((id): id is string => !!id))]);
    return rows.map((row) => {
      const user = row.publishedById ? names.get(row.publishedById) : undefined;
      return {
        version: row.version,
        publishedAt: row.publishedAt,
        publishedBy: row.publishedById ? { id: row.publishedById, name: user ? (user.name ?? user.email) : null } : null,
        rolledBackFromVersion: row.rolledBackFromVersion,
        isCurrent: row.version === latest.version,
      };
    });
  }

  static async getVersion(version: number) {
    const row = await SupportContentRepo.findVersion(version);
    if (!row) throw new HttpError("That version doesn't exist.", 404, "SUPPORT_VERSION_NOT_FOUND");
    return {
      version: row.version,
      publishedAt: row.publishedAt,
      publishedBy: await actorOf(row.publishedById),
      rolledBackFromVersion: row.rolledBackFromVersion,
      content: row.content as unknown as SupportContent,
    };
  }

  /** Publishes an exact copy of an earlier version as the newest one, and points the draft at it. */
  static async rollback(version: number, adminId: string) {
    const target = await SupportContentRepo.findVersion(version);
    if (!target) throw new HttpError("That version doesn't exist.", 404, "SUPPORT_VERSION_NOT_FOUND");
    const latest = await SupportContentSvc.latestVersion();
    if (target.version === latest.version) throw new HttpError("That version is already the published one.", 409, "ALREADY_CURRENT");

    let created;
    try {
      created = await prisma.$transaction(async (tx) => {
        const current = await SupportContentRepo.findLatestVersion(tx);
        const next = (current?.version ?? 0) + 1;
        const row = await SupportContentRepo.createVersion(
          { version: next, content: asJson(clone(target.content as unknown as SupportContent)), publishedById: adminId, rolledBackFromVersion: target.version },
          tx,
        );
        await SupportContentRepo.resetDraft(asJson(clone(target.content as unknown as SupportContent)), next, adminId, tx);
        return row;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError("Another publish just happened. Reload and try again.", 409, "PUBLISH_CONFLICT");
      throw err;
    }
    await SecurityAuditSvc.record({
      action: "admin.support_content.rolled_back",
      actorId: adminId,
      organizationId: null,
      targetType: "support_content",
      targetId: String(created.version),
      payload: { version: created.version, restoredVersion: target.version },
    });
    return { version: created.version, publishedAt: created.publishedAt, rolledBackFromVersion: target.version };
  }
}
