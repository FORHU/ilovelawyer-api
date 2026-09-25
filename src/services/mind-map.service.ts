import ChatRepo from "../repositories/chat.repository";
import MindMapRepo, { MindMapKind, MindMapVersionConflictError } from "../repositories/mind-map.repository";
import OrganizationRepo from "../repositories/organization.repository";
import CaseAccess from "../utils/case-access";
import HttpError from "../utils/http-error";
import logger from "../utils/logger";
import { getChatWonderSessionId, streamChatWonderMessage } from "../utils/chatWonder";
import { getMindMapExpandPromptBuilder } from "../legal/prompt-registry";
import { MIND_MAP_LIMITS } from "../constants/mind-map-limits.constants";
import { MindMapItem, normalizeMindMap } from "../utils/response-parser";
import {
  appendMindMapChildren,
  countMindMapNodes,
  findMindMapNode,
  parseExpandedChildren,
} from "../utils/mind-map-tree";
import AiGenerationLockSvc from "./ai-generation-lock.service";
import DocumentChunkSvc from "./document-chunk.service";

/** How many times a save retries after another expand/undo landed on the same map mid-flight.
 * Each retry re-reads the map and re-applies the same children — no second model call. */
const SAVE_ATTEMPTS = 3;

/** Machine-readable reasons a node can't be expanded — the app shows these as its "Map limit
 * reached" hint instead of a generic error (see the Map expansion limits decision). */
export type MindMapLimitCode = "MAX_DEPTH" | "MAX_NODES";

export class MindMapLimitError extends HttpError {
  constructor(code: MindMapLimitCode, message: string) {
    super(message, 422, code);
  }
}

interface ConsultationTarget {
  organizationId: string;
  userId: string;
  consultationId: string;
  /** Which message's map to act on; defaults to the consultation's active (newest) map. */
  messageId?: string;
}

interface CaseTarget {
  userId: string;
  caseId: string;
}

/** One map, whichever table it lives in — what expand/undo actually operate on. */
interface MapRef {
  kind: MindMapKind;
  id: string;
  data: unknown;
  version: number;
  caseId: string;
  /** Message maps only. */
  messageId?: string;
}

/** What expand/undo return — the whole updated tree, so the app can swap it into its cache. */
export interface MindMapChange {
  kind: MindMapKind;
  caseId: string;
  messageId?: string;
  version: number;
  mindMap: MindMapItem;
  expandedNodeId?: string;
}

const STALE_MESSAGE = "The mind map changed since you last loaded it";

export default class MindMapSvc {
  /** Same access rule as chatting in the consultation: the consultation belongs to this org and
   * the user can open its case. Mind maps are case-only (CONTEXT.md), so a consultation with no
   * case has nothing to expand. */
  private static async loadConsultationMap(t: ConsultationTarget): Promise<MapRef> {
    const consultation = await ChatRepo.findConsultationById(t.consultationId);
    if (!consultation || consultation.organizationId !== t.organizationId) {
      throw new HttpError("Consultation not found", 404);
    }
    if (!consultation.caseId) throw new HttpError("Mind maps are only available on case consultations", 400);
    await CaseAccess.loadAccessibleCase(consultation.caseId, t.userId);

    const row = t.messageId
      ? await MindMapRepo.findByMessage(t.consultationId, t.messageId)
      : await MindMapRepo.findActiveForConsultation(t.consultationId);
    if (!row) throw new HttpError("Mind map not found", 404);
    return { kind: "message", id: row.id, data: row.data, version: row.version, caseId: consultation.caseId, messageId: row.messageId };
  }

  /** The case's document-built map (CaseMindMapSvc). Anyone who can open the case. */
  private static async loadCaseMap(t: CaseTarget): Promise<MapRef> {
    await CaseAccess.loadAccessibleCase(t.caseId, t.userId);
    const row = await MindMapRepo.findCaseMap(t.caseId);
    if (!row) throw new HttpError("Mind map not found", 404);
    return { kind: "case", id: row.id, data: row.data, version: row.version, caseId: t.caseId };
  }

  private static normalized(data: unknown): MindMapItem {
    const tree = normalizeMindMap(data);
    if (!tree) throw new HttpError("Saved mind map is unreadable", 500);
    return tree;
  }

  /** Throws MindMapLimitError when `node` can't take any more children; otherwise returns how
   * many it may take (≤ `requested`). */
  static roomFor(tree: MindMapItem, node: MindMapItem, requested: number): number {
    const { maxDepth, maxNodes } = MIND_MAP_LIMITS;
    if ((node.depth ?? 0) >= maxDepth) {
      throw new MindMapLimitError("MAX_DEPTH", `This node is at the maximum depth (${maxDepth} levels)`);
    }
    const room = maxNodes - countMindMapNodes(tree);
    if (room <= 0) throw new MindMapLimitError("MAX_NODES", `Map limit reached (${maxNodes} nodes)`);
    return Math.min(requested, room);
  }

  /** Expand a node on a consultation's (chat-generated) map. */
  static async expandNode(t: ConsultationTarget & { nodeId: string; count?: number }): Promise<MindMapChange> {
    return MindMapSvc.expandOnMap(await MindMapSvc.loadConsultationMap(t), t.userId, t.nodeId, t.count);
  }

  /** Expand a node on the case's document-built map. */
  static async expandCaseNode(t: CaseTarget & { nodeId: string; count?: number }): Promise<MindMapChange> {
    return MindMapSvc.expandOnMap(await MindMapSvc.loadCaseMap(t), t.userId, t.nodeId, t.count);
  }

  /** "Undo expand" on a consultation's map. */
  static async revert(t: ConsultationTarget & { expectedVersion?: number }): Promise<MindMapChange> {
    return MindMapSvc.revertMap(await MindMapSvc.loadConsultationMap(t), t.userId, t.expectedVersion);
  }

  /** "Undo expand" on the case's map. Only steps back over expands/edits — never over a build,
   * which Regenerate/the post-upload refresh own. */
  static async revertCaseMap(t: CaseTarget & { expectedVersion?: number }): Promise<MindMapChange> {
    const ref = await MindMapSvc.loadCaseMap(t);
    if (!(await MindMapRepo.caseMapHasUserChanges(ref.id))) throw new HttpError("Nothing to undo on this mind map", 409);
    return MindMapSvc.revertMap(ref, t.userId, t.expectedVersion);
  }

  private static async expandOnMap(ref: MapRef, userId: string, requestedNodeId: string, requestedCount?: number): Promise<MindMapChange> {
    const tree = MindMapSvc.normalized(ref.data);
    const found = findMindMapNode(tree, requestedNodeId);
    if (!found) throw new HttpError("Node not found on this mind map", 404);
    if (found.node.isRoot) {
      // The five first-level branches are fixed (Map expansion limits decision) — growth happens
      // under them, never beside them.
      throw new HttpError("The map's top-level branches are fixed; expand one of them instead", 400);
    }
    const { expandMin, expandMax } = MIND_MAP_LIMITS;
    const requested = Math.min(Math.max(requestedCount ?? 3, expandMin), expandMax);
    const count = MindMapSvc.roomFor(tree, found.node, requested);
    const nodeId = found.node.id;
    const { caseId } = ref;

    // Keyed to the map + node, not the case: two different nodes expand in parallel (the save
    // below re-applies onto whatever landed first); the same node twice is refused (409).
    const lockSubject = `mindmap:${ref.id}:${nodeId}`;
    return AiGenerationLockSvc.run(lockSubject, "mindMapExpand", async () => {
      const startedAt = Date.now();
      const tenantCode = await CaseAccess.resolveTenantCode(caseId);
      const ukJurisdiction = tenantCode === "UK" ? await CaseAccess.resolveUkJurisdiction(caseId) : null;
      const caseRecord = await CaseAccess.loadAccessibleCase(caseId, userId);

      const siblings = (found.parent?.children ?? []).filter((c) => c.id !== nodeId).map((c) => c.label);
      const existingChildren = found.node.children.map((c) => c.label);
      const prompt = getMindMapExpandPromptBuilder(tenantCode)({
        caseName: caseRecord.caseName,
        actionType: caseRecord.actionType,
        path: found.path.map((n) => n.label),
        node: { label: found.node.label, description: found.node.description },
        siblings,
        existingChildren,
        count,
        ukJurisdiction,
      });

      // The case documents most relevant to this branch — chat-wonder reads these chunks as
      // context, the same grounding a chat turn about this topic would get.
      const grounding = await DocumentChunkSvc.relevantChunksForCase(
        caseId,
        [...found.path.slice(1).map((n) => n.label), found.node.description ?? ""].join(" — "),
      );

      const call = (sessionId: string) =>
        streamChatWonderMessage(
          sessionId,
          prompt,
          () => {},
          undefined,
          grounding.caseDocumentIds.length ? grounding : undefined,
          undefined,
          tenantCode,
          undefined,
          undefined,
          undefined,
          { resolveOnAnswerEnd: true },
        );
      let result;
      try {
        result = await call(await getChatWonderSessionId());
      } catch {
        result = await call(await getChatWonderSessionId());
      }

      const children = parseExpandedChildren(result.content, [...siblings, ...existingChildren, found.node.label], count);
      logger.info("Mind map expand: model reply", {
        caseId,
        kind: ref.kind,
        nodeId,
        requested: count,
        parsed: children.length,
        durationMs: Date.now() - startedAt,
      });
      if (!children.length) throw new HttpError("The AI didn't return any new points for this node", 502);

      const saved = await MindMapSvc.saveWithRetry(ref, (latestTree) => {
        const target = findMindMapNode(latestTree, nodeId);
        if (!target) throw new HttpError("This node was removed while it was being expanded", 409);
        // Another expand may have used up room since the first check.
        const fits = MindMapSvc.roomFor(latestTree, target.node, children.length);
        return appendMindMapChildren(latestTree, nodeId, children.slice(0, fits));
      }, { reason: "expand", nodeId, userId });

      await OrganizationRepo.writeAudit({
        caseId,
        actorId: userId,
        action: "mindMap.expand",
        payload: { kind: ref.kind, messageId: ref.messageId, nodeId, added: children.length, version: saved.version },
      });
      return { kind: ref.kind, caseId, messageId: ref.messageId, expandedNodeId: nodeId, version: saved.version, mindMap: saved.mindMap };
    });
  }

  /** Steps the map back one version. `expectedVersion`, when the client sends it, makes a stale
   * undo (the map moved on since the user looked) fail with 409 instead of undoing someone
   * else's change. */
  private static async revertMap(ref: MapRef, userId: string, expectedVersion?: number): Promise<MindMapChange> {
    if (expectedVersion !== undefined && expectedVersion !== ref.version) throw new HttpError(STALE_MESSAGE, 409);
    let reverted;
    try {
      reverted = await MindMapRepo.revertOneVersion(ref.kind, ref.id, ref.version);
    } catch (err) {
      if (err instanceof MindMapVersionConflictError) throw new HttpError(STALE_MESSAGE, 409);
      throw err;
    }
    await OrganizationRepo.writeAudit({
      caseId: ref.caseId,
      actorId: userId,
      action: "mindMap.revert",
      payload: { kind: ref.kind, messageId: ref.messageId, fromVersion: ref.version, toVersion: reverted.version },
    });
    return { kind: ref.kind, caseId: ref.caseId, messageId: ref.messageId, version: reverted.version, mindMap: reverted.data };
  }

  /** Re-reads the map, applies `change`, saves as the next version; on a version conflict
   * (another expand/undo/rebuild landed in between) repeats with the fresh map. */
  private static async saveWithRetry(
    ref: MapRef,
    change: (tree: MindMapItem) => MindMapItem | null,
    meta: { reason: "expand" | "edit"; nodeId: string; userId: string },
  ): Promise<{ version: number; mindMap: MindMapItem }> {
    for (let attempt = 1; attempt <= SAVE_ATTEMPTS; attempt++) {
      const latest = await MindMapRepo.findById(ref.kind, ref.id);
      if (!latest) throw new HttpError("Mind map not found", 404);
      const next = change(MindMapSvc.normalized(latest.data));
      if (!next) throw new HttpError("This node was removed while it was being expanded", 409);
      try {
        const { version } = await MindMapRepo.saveNewVersion({
          kind: ref.kind,
          mindMapId: ref.id,
          expectedVersion: latest.version,
          previousData: latest.data as unknown as MindMapItem,
          data: next,
          ...meta,
        });
        return { version, mindMap: next };
      } catch (err) {
        if (!(err instanceof MindMapVersionConflictError)) throw err;
        if (attempt === SAVE_ATTEMPTS) throw new HttpError("Mind map is busy, try again", 409);
        logger.info("Mind map save: version moved on, re-applying", { mindMapId: ref.id, attempt });
      }
    }
    throw new HttpError("Mind map is busy, try again", 409);
  }
}
